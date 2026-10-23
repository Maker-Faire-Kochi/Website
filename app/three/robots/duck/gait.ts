import { rng, type Rng } from '../../core/rng'
import type { Collider, ContactOther, Normal } from '../contact'
import { DuckFall, toWorld } from './fall'
import { LEG } from './ik'

/**
 * The duck's gait: a PROCEDURAL, KINEMATIC walk. Nothing here is physically
 * simulated -- there are no forces, no contacts and no balance controller.
 * A phase clock decides when each foot lifts and lands, footholds are planned
 * in WORLD space from the commanded velocity and yaw rate, and the pelvis is
 * moved along a smooth reference path with a bob, a sway and a lean layered
 * on top. The legs are then solved with the 6-DOF IK in ik.ts so each sole
 * lands exactly where the planner put it.
 *
 * What makes it read as a real machine walking, and what the tests hold it to:
 * - A stance foot NEVER moves. It is written once, at touchdown, and nothing
 *   touches it until liftoff -- so there is no sliding to hide. If the body
 *   would run away from a planted foot, the body is slowed down (the
 *   "governor"); the foot target is never clamped.
 * - Swing feet travel on raised-cosine arcs and stay flat.
 * - The pelvis bobs at twice the stride frequency (low in double support,
 *   high at mid-swing, like an inverted pendulum), sways toward the stance
 *   foot, rolls with the sway (the waddle) and leans forward with speed.
 * - Starting and stopping come out as half steps, because footholds are
 *   planned from the body's predicted (eased) motion.
 * - Turning rotates successive footholds; the turn per step is bounded so the
 *   hip yaw stays well inside its +-45 degree servo limit.
 *
 * Everything advances in step(dt) only, from a seeded PRNG, so the same seed
 * and the same number of steps always produce the same pose.
 */

const TAU = Math.PI * 2
const deg = Math.PI / 180
const REACH = LEG.L1 + LEG.L2

export const GAIT = {
  /** One step = half a stride. Stride period 0.6 s. */
  stepTime: 0.3,
  /** Quick recovery steps after a shove. */
  staggerStepTime: 0.2,
  /** Double-support share of each step: 0.2 of a step on each side = duty factor 0.6. */
  ds: 0.2,
  swingH: 0.024,
  maxSpeed: 0.2,
  maxBack: 0.12,
  maxYawRate: 1.6,
  accel: 0.5,
  yawAccel: 4,
  /** How hard the governor may brake when a planted foot is about to be outrun. */
  govAccel: 2.5,
  govYawAccel: 12,
  staggerSpeed: 0.2,
  staggerAccel: 3,
  /** Side-step speed limit (dance strafe, sideways stagger), m/s. */
  maxStrafe: 0.12,
  /** Governor: furthest a planted foot may sit sideways from under its hip (m). */
  latReach: 0.025,
  /** Governor: furthest a planted foot may get ahead of / behind the body reference (m). */
  reach: 0.05,
  /** Governor: largest planted-foot yaw relative to the pelvis (rad); the hip yaw servo allows 45 deg. */
  yawReach: 0.55,
  /** Footholds: closest a swing foot may land to the stance foot, sideways. */
  minSep: 2 * LEG.hipW - 0.02,
  maxStep: 0.09,
  maxStepYaw: 0.6,
  /** Pelvis height when standing: leg extension 0.82 of full reach (A1.1 §4). */
  standH: LEG.ankleH + 0.82 * REACH,
  bob: 0.004,
  sway: 0.011,
  rollMax: 4.5 * deg,
  nod: 1.2 * deg,
  pitchPerSpeed: 6 * deg / 0.2,
  pitchMax: 8 * deg,
  rollLimit: 6 * deg,
  /** Neck/head look limits. */
  yawLimit: 70 * deg,
  pitchLimit: 35 * deg,
  neckOmega: 9,
  headOmega: 16,
  headZeta: 0.7,
}

/**
 * The hop: a SCRIPTED sequence, not a simulation. Crouch, a constant-
 * acceleration push that ends at exactly the take-off speed, a ballistic arc
 * (g = 9.81) with the legs tucking, and a critically-damped squash on landing.
 * Both soles stay flat throughout and land on a squared stance moved forward
 * by `dist`.
 */
export const HOP = {
  crouchT: 0.2,
  crouchD: 0.62 * REACH,
  takeoffD: 0.92 * REACH,
  v0: 0.9,
  g: 9.81,
  tuck: 0.12 * REACH,
  landT: 0.55,
  landOmega: 13,
  dist: 0.035,
  pitch: 5 * deg,
}
const HOP_D = HOP.takeoffD - HOP.crouchD
const HOP_PUSH_T = 2 * HOP_D / HOP.v0
const HOP_ACC = HOP.v0 * HOP.v0 / (2 * HOP_D)
const HOP_FLIGHT_T = 2 * HOP.v0 / HOP.g
export const HOP_TOTAL = HOP.crouchT + HOP_PUSH_T + HOP_FLIGHT_T + HOP.landT

/**
 * Contact (robots/contact.ts). Circles that follow the silhouette seen from
 * above: the torso box (0.11 x 0.11, 1 cm behind the hips, tail rail at the
 * back) as two circles fore and aft, carried with the swaying pelvis; the
 * helmet head (58 mm wide, ~100 mm long with its bill) as two along the
 * neck's heading; and each sole plate (42 x 85 mm) as a heel and a toe
 * circle. A PLANTED sole is `fixed`: the gait never moves a stance foot, so
 * whatever runs into one takes the whole correction (and the duck still
 * feels the impact and staggers). A swing sole is movable: one about to come
 * down inside another robot has its landing re-aimed.
 *
 * Response: the overlap moves the body reference (and so the pelvis) and an
 * airborne foot's landing target; planted feet stay where they are and the
 * legs take up the offset through the IK. Any real impact, or a slow push
 * that has shifted the body more than `replant`, starts a STAGGER along the
 * push: quick recovery steps that re-plant both feet under the moved body --
 * the same scripted stagger as a shove, now in any direction, its speed
 * scaled by the impact. During a hop's crouch, push and landing the duck is
 * fixed (its feet are planted and the hop is scripted); in flight it moves.
 */
/** Contact time credited per blocked-fall contact (one per solver call: the fixed step). */
const DUCK_FALL_DT = 0.005 / 8

export const DUCK_SHAPE = {
  mass: 1.3,
  /** Torso circles: radius, and their centres along the heading from the pelvis. */
  bodyR: 0.061,
  bodyAt: [-0.04, 0.02],
  headR: 0.03,
  /** The helmet's reach on the floor when the duck lies down (its circles grow to it). */
  helmetR: 0.065,
  headAt: [0.07, 0.11],
  /** Sole circles: radius, heel and toe centres along the foot from the sole centre. */
  footR: 0.022,
  footAt: [-0.011, 0.031],
  replant: 0.004,
  /** An impact share (m/s) above which the duck is knocked right over instead of staggering. */
  topple: 0.3,
  /** A swing foot caught at this closing speed share (m/s) trips it: it falls forward over the snag. */
  trip: 0.18,
  /** A grab pull (N) beyond which, held for `pullTime` s, it is dragged over; above `nudge` it steps toward the pull. */
  pullTopple: 5.5,
  pullTime: 0.12,
  pullNudge: 2.5,
  /** Impact share (m/s) below which a hit does not stagger the duck (a rolling ball's is ~0.02). */
  stumbleMin: 0.03,
  /** Stagger speed = clamp(base + gain * impact, base, max). */
  stagBase: 0.08,
  stagGain: 0.6,
  stagMax: 0.22,
}

/** Eye position in the body frame (approximate, for aiming the look). */
const EYE_Y = 0.22
const EYE_Z = 0.11

/**
 * A sole pose. Walking, a sole is always flat (pitch = roll = 0); only a
 * fallen duck's tucked feet tilt with its body (see fall.ts).
 */
export interface Sole { x: number, y: number, z: number, yaw: number, pitch?: number, roll?: number }

export interface DuckPose {
  /** Pelvis (hip-axis centre) world position and orientation (yaw, then pitch, then roll). */
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
  /** Sole centres in world space; 0 = left (+X side), 1 = right. Soles are always flat. */
  feet: [Sole, Sole]
  /** Look springs, relative to the body: the neck leads, the head follows it (follow-through). */
  neckYaw: number
  neckPitch: number
  headYaw: number
  headPitch: number
}

export interface Command { speed: number, yawRate: number, strafe?: number }
export interface Point { x: number, y: number, z: number }

export function newPose(): DuckPose {
  return {
    x: 0, y: GAIT.standH, z: 0, yaw: 0, pitch: 0, roll: 0,
    feet: [{ x: LEG.hipW, y: 0, z: 0, yaw: 0 }, { x: -LEG.hipW, y: 0, z: 0, yaw: 0 }],
    neckYaw: 0, neckPitch: 0, headYaw: 0, headPitch: 0,
  }
}

export function copyPose(src: DuckPose, dst: DuckPose) {
  dst.x = src.x; dst.y = src.y; dst.z = src.z
  dst.yaw = src.yaw; dst.pitch = src.pitch; dst.roll = src.roll
  for (let i = 0; i < 2; i++) Object.assign(dst.feet[i]!, src.feet[i])
  dst.neckYaw = src.neckYaw; dst.neckPitch = src.neckPitch
  dst.headYaw = src.headYaw; dst.headPitch = src.headPitch
}

/** Linear blend of two poses (angles are never wrapped, so plain lerp is right). */
export function lerpPose(a: DuckPose, b: DuckPose, t: number, out: DuckPose) {
  const l = (p: number, q: number) => p + (q - p) * t
  out.x = l(a.x, b.x); out.y = l(a.y, b.y); out.z = l(a.z, b.z)
  out.yaw = l(a.yaw, b.yaw); out.pitch = l(a.pitch, b.pitch); out.roll = l(a.roll, b.roll)
  for (let i = 0; i < 2; i++) {
    const fa = a.feet[i]!, fb = b.feet[i]!, fo = out.feet[i]!
    fo.x = l(fa.x, fb.x); fo.y = l(fa.y, fb.y); fo.z = l(fa.z, fb.z); fo.yaw = l(fa.yaw, fb.yaw)
    if (fa.pitch || fb.pitch || fa.roll || fb.roll || fo.pitch || fo.roll) {
      fo.pitch = l(fa.pitch ?? 0, fb.pitch ?? 0)
      fo.roll = l(fa.roll ?? 0, fb.roll ?? 0)
    }
  }
  out.neckYaw = l(a.neckYaw, b.neckYaw); out.neckPitch = l(a.neckPitch, b.neckPitch)
  out.headYaw = l(a.headYaw, b.headYaw); out.headPitch = l(a.headPitch, b.headPitch)
  return out
}

/** Second-order spring, semi-implicit Euler at the fixed step. zeta = 1 is critically damped. */
export class Spring {
  x = 0
  v = 0
  step(target: number, omega: number, zeta: number, dt: number) {
    this.v += (omega * omega * (target - this.x) - 2 * zeta * omega * this.v) * dt
    this.x += this.v * dt
  }
  /** Hard stop at a limit: the joint cannot pass it, and it does not bounce off it either. */
  limit(lim: number) {
    if (this.x > lim) { this.x = lim; if (this.v > 0) this.v = 0 }
    else if (this.x < -lim) { this.x = -lim; if (this.v < 0) this.v = 0 }
  }
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const approach = (x: number, target: number, maxDelta: number) =>
  x < target ? Math.min(target, x + maxDelta) : Math.max(target, x - maxDelta)
const smooth = (t: number) => t * t * (3 - 2 * t)
const moving = (c: Command) => Math.abs(c.speed) > 0.004 || Math.abs(c.yawRate) > 0.03 || Math.abs(c.strafe ?? 0) > 0.004

export type GaitMode = 'stand' | 'walk' | 'hop' | 'fall'

export class DuckGait {
  /** Pose after the latest step, and the one before it (for frame interpolation). */
  readonly cur = newPose()
  readonly prev = newPose()

  /** Body reference on the ground: position, heading, forward speed, yaw rate. */
  bx = 0
  bz = 0
  yaw = 0
  v = 0
  w = 0
  mode: GaitMode = 'stand'

  /** Sole poses (world). A planted foot's entry is written only at touchdown. */
  readonly feet: [Sole, Sole] = [{ x: 0, y: 0, z: 0, yaw: 0 }, { x: 0, y: 0, z: 0, yaw: 0 }]
  readonly planted: [boolean, boolean] = [true, true]
  /** Incremented at every touchdown, so a test can tell one stance from the next. */
  readonly stanceId: [number, number] = [0, 0]
  /** True on any step where the governor had to slow the body (diagnostic). */
  governed = false
  /** Sideways body speed (side-step), m/s, + = left. Zero in ordinary walking. */
  u = 0
  /** Body velocity over the last step, world XZ (for contact). */
  vx = 0
  vz = 0
  /** Contact circles: 0-1 torso, 2-3 head, 4-5 left sole (heel, toe), 6-7 right sole (see DUCK_SHAPE). */
  readonly colliders: Collider[] = [0, 1, 2, 3, 4, 5, 6, 7].map(k => ({
    x: 0, z: 0, r: k < 2 ? DUCK_SHAPE.bodyR : k < 4 ? DUCK_SHAPE.headR : DUCK_SHAPE.footR, vx: 0, vz: 0, fixed: k >= 4,
  }))
  /** Sole velocities over the last step (x, z per foot), for contact. */
  readonly footV = new Float64Array(4)
  private readonly footP = new Float64Array(4)
  /** Asleep (easter egg): standing still, sunk a little, head down, breathing slowly. */
  asleep = false
  /** 0..1, eases toward `asleep` over about a second. */
  private sleepK = 0

  private s = 0
  private swing: 0 | 1 = 0
  private nextSwing: 0 | 1 = 0
  private lifted = false
  private phi = 0
  private from: Sole = { x: 0, y: 0, z: 0, yaw: 0 }
  private to: Sole = { x: 0, y: 0, z: 0, yaw: 0 }
  private g = 0
  private t = 0

  private shift = new Spring()
  private shiftTarget = 0
  private shiftTimer = 2
  private pitchKick = new Spring()

  private neckY = new Spring()
  private neckP = new Spring()
  private headY = new Spring()
  private headP = new Spring()
  private look: Point | null = null
  private glanceTimer = 1
  private glanceYaw = 0
  private glancePitch = 0
  private peckT = 0

  private hopQueued = false
  private hopT = 0
  private hopStage = 0
  private hop0: [Sole, Sole] = [{ x: 0, y: 0, z: 0, yaw: 0 }, { x: 0, y: 0, z: 0, yaw: 0 }]
  private hopB = { x: 0, z: 0, dx: 0, dz: 0 }
  private hopY = GAIT.standH
  private hopPitch = 0
  private stagger = 0
  /** Stagger velocity in the body frame: forward, left. A shove is straight back. */
  private stagV = -GAIT.staggerSpeed
  private stagU = 0
  /** Body shift from slow pushes since the feet were last re-planted. */
  private pushed = 0
  private recovering = false
  private readonly cmd: Command = { speed: 0, yawRate: 0, strafe: 0 }
  private readonly fallTmp = [0, 0, 0]

  private readonly rand: Rng

  constructor(seed: number, readonly posterMode = false) {
    this.rand = rng(seed)
    this.placeAt(0, 0, 0)
  }

  get busy() {
    return this.mode === 'hop' || this.mode === 'fall' || this.hopQueued || this.stagger > 0 || this.recovering
  }

  /** From the moment it starts to topple until it stands again. */
  get fallen() {
    return this.mode === 'fall'
  }

  /** The fall in progress (fall.ts): read-only for the drawing and the sounds. */
  readonly fall = new DuckFall()
  /** A grab's pull for the next step: world force (N) applied at `h` m above the ground. */
  readonly ext = { x: 0, y: 0, z: 0, h: 0 }
  private pull = 0

  /** Knock it over toward (dx, dz) at `speed` (m/s at the pelvis). A hop finishes first. */
  startFall(dx: number, dz: number, speed: number) {
    if (this.mode === 'hop' || this.mode === 'fall' || this.posterMode) return
    const l = Math.hypot(dx, dz) || 1
    this.mode = 'fall'
    this.fall.start(dx / l, dz / l, speed, this.cur, this.feet)
    this.planted[0] = this.planted[1] = false
    this.lifted = false
    this.stagger = 0
    this.recovering = false
    this.hopQueued = false
    this.pushed = 0
    this.v = this.w = this.u = 0
    this.neckP.v += 3
  }

  /** The fall drives the pelvis and feet; when it stands again the gait takes over. */
  private fallStep(dt: number) {
    const f = this.fall
    // A drag adds torque about the support edge: the horizontal pull along the fall times its height.
    const dirX = Math.sin(this.yaw) * (f.dir === 'front' ? 1 : f.dir === 'back' ? -1 : 0) + Math.cos(this.yaw) * (f.dir === 'left' ? 1 : f.dir === 'right' ? -1 : 0)
    const dirZ = Math.cos(this.yaw) * (f.dir === 'front' ? 1 : f.dir === 'back' ? -1 : 0) - Math.sin(this.yaw) * (f.dir === 'left' ? 1 : f.dir === 'right' ? -1 : 0)
    const torque = (this.ext.x * dirX + this.ext.z * dirZ) * this.ext.h
    const done = f.step(dt, f.phase === 'topple' ? torque : 0, DUCK_SHAPE.mass)
    for (let i = 0; i < 2; i++) {
      const s = f.feet[i]!, d = this.feet[i]!
      d.x = s.x
      d.y = s.y
      d.z = s.z
      d.yaw = s.yaw
      d.pitch = s.pitch
      d.roll = s.roll
    }
    this.bx = f.x
    this.bz = f.z
    if (f.phase === 'rise' && !this.planted[0]) {
      // The feet came down at the end of the roll: planted from here on.
      this.planted[0] = this.planted[1] = true
      this.stanceId[0]++
      this.stanceId[1]++
    }
    if (!done) return
    // Standing again (or it rocked back without going over): squared stance, then a small balancing stagger.
    const rose = f.phase === 'done' && this.planted[0]
    this.mode = 'stand'
    this.s = 0
    this.lifted = false
    for (let i = 0; i < 2; i++) {
      const d = this.feet[i]!
      d.pitch = 0
      d.roll = 0
      d.y = 0
      if (!this.planted[i]) {
        this.planted[i] = true
        this.stanceId[i] = this.stanceId[i]! + 1
      }
    }
    if (rose || !this.squared()) {
      this.bx = (this.feet[0]!.x + this.feet[1]!.x) / 2
      this.bz = (this.feet[0]!.z + this.feet[1]!.z) / 2
      this.stumble({ x: -dirX, z: -dirZ }, 0.05)
    }
  }

  /** Teleport to a squared standing pose. */
  placeAt(x: number, z: number, heading: number) {
    this.bx = x
    this.bz = z
    this.yaw = heading
    this.v = this.w = 0
    this.u = 0
    this.mode = 'stand'
    this.lifted = false
    this.s = 0
    this.g = 0
    this.stagger = 0
    this.pushed = 0
    this.recovering = false
    this.hopQueued = false
    this.fall.phase = 'done'
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i]!
      f.pitch = 0
      f.roll = 0
      const side = i === 0 ? 1 : -1
      f.x = x + Math.cos(heading) * side * LEG.hipW
      f.z = z - Math.sin(heading) * side * LEG.hipW
      f.y = 0
      f.yaw = heading
      this.planted[i] = true
    }
    this.compose()
    copyPose(this.cur, this.prev)
    this.vx = this.vz = 0
    this.updateColliders()
  }

  lookAt(p: Point | null) {
    this.look = p ? { x: p.x, y: p.y, z: p.z } : null
  }

  /** 'tap' = hop (after coming to a stop if walking); 'shove' = two quick recovery steps backward; 'tumble' = knocked over backward. */
  react(kind: 'tap' | 'shove' | 'tumble') {
    if (kind === 'tumble') {
      this.startFall(-Math.sin(this.yaw), -Math.cos(this.yaw), 0.9)
      return
    }
    if (this.busy) return
    if (kind === 'tap') {
      this.hopQueued = true
      return
    }
    this.stagger = 2
    this.stagV = -GAIT.staggerSpeed
    this.stagU = 0
    this.pitchKick.v -= 1.6
    this.neckP.v += 2.5
    if (this.mode === 'stand') this.startWalk({ speed: -1, yawRate: 0 })
  }

  /** Pausing drops what has not started yet; a hop or stagger in progress finishes when motion resumes. */
  setPaused(paused: boolean) {
    if (paused) {
      this.hopQueued = false
      this.look = null
    }
  }

  step(dt: number, cmdIn: Command) {
    copyPose(this.cur, this.prev)
    this.t += dt
    const bx0 = this.bx, bz0 = this.bz
    for (let i = 0; i < 2; i++) {
      this.footP[2 * i] = this.feet[i]!.x
      this.footP[2 * i + 1] = this.feet[i]!.z
    }
    const cmd = this.cmd
    if (this.posterMode) {
      cmd.speed = cmd.yawRate = cmd.strafe = 0
    }
    else {
      cmd.speed = clamp(cmdIn.speed, -GAIT.maxBack, GAIT.maxSpeed)
      cmd.yawRate = clamp(cmdIn.yawRate, -GAIT.maxYawRate, GAIT.maxYawRate)
      cmd.strafe = clamp(cmdIn.strafe ?? 0, -GAIT.maxStrafe, GAIT.maxStrafe)
    }
    if (this.stagger > 0) {
      cmd.speed = this.stagV
      cmd.yawRate = 0
      cmd.strafe = this.stagU
    }
    else if (this.hopQueued || this.recovering || this.asleep || this.mode === 'fall') {
      cmd.speed = 0
      cmd.yawRate = 0
      cmd.strafe = 0
    }

    // A grab: a steady hard pull drags it over; a moderate one makes it step toward the pull.
    const pullH = Math.hypot(this.ext.x, this.ext.z)
    if (this.mode !== 'fall' && this.mode !== 'hop' && pullH > 0) {
      this.pull = pullH > DUCK_SHAPE.pullTopple ? this.pull + dt : Math.max(0, this.pull - dt)
      if (this.pull > DUCK_SHAPE.pullTime) {
        this.pull = 0
        this.startFall(this.ext.x, this.ext.z, 0.08 * pullH)
      }
      else if (pullH > DUCK_SHAPE.pullNudge) {
        this.stumble({ x: this.ext.x / pullH, z: this.ext.z / pullH }, 0.02 * pullH)
      }
    }

    if (this.mode === 'stand') {
      if (this.hopQueued) this.startHop()
      else if (moving(cmd)) this.startWalk(cmd)
    }
    this.governed = false
    if (this.mode === 'walk') this.walkStep(dt, cmd)
    else if (this.mode === 'hop') this.hopStep(dt)
    else if (this.mode === 'fall') this.fallStep(dt)
    else this.standStep(dt)

    this.g += ((this.mode === 'walk' ? 1 : 0) - this.g) * Math.min(1, dt / 0.1)
    if (this.asleep || this.sleepK !== 0) {
      this.sleepK += ((this.asleep ? 1 : 0) - this.sleepK) * Math.min(1, dt / 0.6)
      if (!this.asleep && this.sleepK < 1e-4) this.sleepK = 0
    }
    this.pitchKick.step(0, 10, 0.45, dt)
    this.shift.step(this.mode === 'stand' && !this.posterMode ? this.shiftTarget : 0, 3.5, 1, dt)
    this.lookStep(dt)
    this.compose()
    this.vx = (this.bx - bx0) / dt
    this.vz = (this.bz - bz0) / dt
    for (let i = 0; i < 2; i++) {
      this.footV[2 * i] = (this.feet[i]!.x - this.footP[2 * i]!) / dt
      this.footV[2 * i + 1] = (this.feet[i]!.z - this.footP[2 * i + 1]!) / dt
    }
    this.updateColliders()
  }

  // ── Contact ─────────────────────────────────────────────────────────────

  updateColliders() {
    const cs = this.colliders
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw)
    // Crouching, pushing off or landing a hop, the duck cannot be moved: the
    // hop is scripted from planted feet. In flight it can.
    // Crouching, pushing off or landing a hop -- or pushing up out of a fall
    // over its planted feet -- the duck cannot be moved: those are scripted.
    const pinned = (this.mode === 'hop' && this.hopStage !== 2) || (this.mode === 'fall' && this.fall.phase === 'rise')
    // Torso and head ride on the pelvis (with its sway), the head turned with the neck.
    const px = this.cur.x, pz = this.cur.z
    const ha = this.yaw + this.cur.neckYaw
    const hx = Math.sin(ha), hz = Math.cos(ha)
    for (let k = 0; k < 4; k++) {
      const c = cs[k]!
      const at = k < 2 ? DUCK_SHAPE.bodyAt[k]! : DUCK_SHAPE.headAt[k - 2]!
      c.x = px + (k < 2 ? fx : hx) * at
      c.z = pz + (k < 2 ? fz : hz) * at
      c.vx = this.vx
      c.vz = this.vz
      c.fixed = pinned
      // Height bands: torso from the hips up; the helmet up on its neck. The
      // legs between are open -- a ball can roll between them to the feet.
      c.y0 = this.cur.y + (k < 2 ? -0.01 : 0.17)
      c.y1 = this.cur.y + (k < 2 ? 0.11 : 0.3)
      c.r = k < 2 ? DUCK_SHAPE.bodyR : DUCK_SHAPE.headR
      if (this.mode === 'fall') {
        // Tipped over: carry the torso and head points with the tilted pelvis.
        // Lying, the helmet (and its antennas) is what reaches furthest along
        // the floor: its circles take the helmet's full size.
        const t = this.fallTmp
        if (k >= 2) c.r = DUCK_SHAPE.helmetR
        toWorld(this.yaw, this.cur.pitch, this.cur.roll, 0, k < 2 ? 0.06 : 0.26, at, t)
        c.x = this.cur.x + t[0]!
        c.z = this.cur.z + t[2]!
        const y = this.cur.y + t[1]!
        // Lying, the torso and helmet are only about a hand's height thick.
        c.y0 = Math.max(0, y - 0.05)
        c.y1 = y + 0.05
      }
    }
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i]!
      // Planted: fixed. In the air: movable -- a swing foot about to land in
      // another robot is re-aimed (collide), so no sole is ever planted inside one.
      const planted = this.planted[i]!
      const sx = Math.sin(f.yaw), sz = Math.cos(f.yaw)
      for (let e = 0; e < 2; e++) {
        const c = cs[4 + 2 * i + e]!
        c.fixed = planted
        // A swing foot moves at its own speed (that is what kicks a ball), not the body's.
        c.vx = planted ? 0 : this.footV[2 * i]!
        c.vz = planted ? 0 : this.footV[2 * i + 1]!
        c.y0 = f.y
        c.y1 = f.y + 0.035
        c.x = f.x + sx * DUCK_SHAPE.footAt[e]!
        c.z = f.z + sz * DUCK_SHAPE.footAt[e]!
      }
    }
  }

  /** Contact response (DUCK_SHAPE): shift the body, never a planted foot; stagger away from real hits. */
  collide(n: Normal, depth: number, relSpeed: number, _other: ContactOther, part: number) {
    const c = this.colliders[part]
    if (part >= 4 && this.mode === 'walk' && this.lifted && (part - 4) >> 1 === this.swing && relSpeed > DUCK_SHAPE.trip) {
      // The swinging foot snagged on something heavy: a trip, over it goes, forward.
      this.startFall(Math.sin(this.yaw), Math.cos(this.yaw), 0.35 + Math.abs(this.v))
      this.updateColliders()
      return
    }
    // Toppling into something -- a robot, a goal's net, a wall: it stops the fall there (fall.ts).
    if (this.mode === 'fall' && part < 4 && depth > 0) this.fall.blocked(DUCK_FALL_DT)
    if (depth > 0 && c && c.fixed) {
      // The solver only pushes a planted part when a body is jammed against
      // it with nowhere else to go (contact.ts, CONTACT.jam): then the whole
      // duck slips, stance feet and all, rather than leave the overlap.
      this.slip(n.x * depth, n.z * depth)
      this.pushed += depth
    }
    else if (depth > 0 && c && !c.fixed) {
      if (part >= 4 && this.mode === 'walk' && this.lifted && (part - 4) >> 1 === this.swing) {
        this.reaim(n.x * depth, n.z * depth)
      }
      else {
        this.shiftBody(n.x * depth, n.z * depth)
        this.pushed += depth
      }
    }
    // A ball or a block barely moves a duck: only a real shove (or a slow push that has moved it) staggers it.
    if (relSpeed > DUCK_SHAPE.stumbleMin || this.pushed > DUCK_SHAPE.replant) this.stumble(n, relSpeed)
    this.updateColliders()
  }

  /**
   * The swing foot is about to come down in something: move its landing
   * target so the foot (which follows from + (to - from) * k) moves by d now
   * and lands clear. Early in the swing (k small) the target moves at most 5 d.
   */
  private reaim(dx: number, dz: number) {
    const u = clamp((this.s - GAIT.ds) / (1 - GAIT.ds), 0, 1)
    const k = (1 - Math.cos(Math.PI * u)) / 2
    const kk = Math.max(k, 0.2)
    this.to.x += dx / kk
    this.to.z += dz / kk
    const f = this.feet[this.swing]!
    f.x += dx * k / kk
    f.z += dz * k / kk
  }

  /** Slide the whole duck, planted feet too (a jam the solver could not clear otherwise). */
  private slip(dx: number, dz: number) {
    this.shiftBody(dx, dz)
    // shiftBody already carries the feet in a fall or a hop; otherwise the planted ones slide now.
    if (this.mode !== 'fall' && this.mode !== 'hop') {
      for (let i = 0; i < 2; i++) {
        if (!this.planted[i]) continue
        this.feet[i]!.x += dx
        this.feet[i]!.z += dz
        // A slid foot is a new stance (it did not stay where it was planted).
        this.stanceId[i] = this.stanceId[i]! + 1
      }
      this.compose()
    }
  }

  /** Move the body reference (and the pelvis with it). Planted feet stay; an airborne foot re-aims. */
  private shiftBody(dx: number, dz: number) {
    this.bx += dx
    this.bz += dz
    if (this.mode === 'fall') {
      this.fall.shift(dx, dz)
      for (let i = 0; i < 2; i++) {
        this.feet[i]!.x += dx
        this.feet[i]!.z += dz
      }
    }
    else if (this.mode === 'hop') {
      // Only reached in flight (pinned otherwise): the whole arc moves.
      this.hopB.x += dx
      this.hopB.z += dz
      for (let i = 0; i < 2; i++) {
        this.hop0[i]!.x += dx
        this.hop0[i]!.z += dz
        this.feet[i]!.x += dx
        this.feet[i]!.z += dz
      }
    }
    else if (this.lifted) {
      this.to.x += dx
      this.to.z += dz
    }
    this.compose()
  }

  /** Recovery steps along the push, faster for a harder hit. A hop in progress finishes first. */
  private stumble(n: Normal, impact: number) {
    if (this.posterMode || this.mode === 'hop' || this.mode === 'fall') return
    if (impact > DUCK_SHAPE.topple) {
      // Hit hard enough to go over, not just stagger.
      this.startFall(n.x, n.z, impact)
      return
    }
    const speed = clamp(DUCK_SHAPE.stagBase + DUCK_SHAPE.stagGain * impact, DUCK_SHAPE.stagBase, DUCK_SHAPE.stagMax)
    // Already staggering: only a harder hit re-aims it.
    if (this.stagger > 0 && speed <= Math.hypot(this.stagV, this.stagU) + 1e-9) return
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw)
    const along = n.x * fx + n.z * fz
    const left = n.x * fz - n.z * fx
    this.stagV = clamp(speed * along, -GAIT.staggerSpeed - 0.02, GAIT.maxSpeed + 0.02)
    this.stagU = clamp(speed * left, -GAIT.maxStrafe, GAIT.maxStrafe)
    this.stagger = impact > 0.25 ? 3 : 2
    this.recovering = false
    this.hopQueued = false
    this.pushed = 0
    const k = clamp(impact / 0.2, 0.3, 1.5)
    this.pitchKick.v += 1.6 * k * along
    this.neckP.v += 2.5 * k
    if (this.mode === 'stand') this.startWalk({ speed: this.stagV, yawRate: 0, strafe: this.stagU })
  }

  /** Fall asleep / wake up (easter egg). Waking is a startle: a jolt of the body and a head snap. */
  setSleep(on: boolean) {
    if (this.asleep && !on && !this.posterMode) {
      this.pitchKick.v -= 1.4
      this.neckP.v += 5
      this.headP.v += 4
    }
    this.asleep = on
  }

  // ── Walking ─────────────────────────────────────────────────────────────

  private startWalk(cmd: Command) {
    this.mode = 'walk'
    this.s = 0
    this.lifted = false
    // Side-stepping, lead with the foot on that side; else step out with the
    // foot on the side we are turning toward; otherwise alternate.
    const st = cmd.strafe ?? 0
    if (Math.abs(st) > 0.004 && Math.abs(st) >= 0.5 * Math.abs(cmd.speed)) this.swing = st > 0 ? 0 : 1
    else this.swing = Math.abs(cmd.yawRate) > 0.1 && this.stagger === 0 ? (cmd.yawRate > 0 ? 0 : 1) : this.nextSwing
  }

  private walkStep(dt: number, cmd: Command) {
    const Ts = this.stagger > 0 ? GAIT.staggerStepTime : GAIT.stepTime
    const ds = GAIT.ds
    const other = (1 - this.swing) as 0 | 1

    // Governor: bounds on speed and yaw rate that keep every planted (or
    // about-to-be-planted) foot within reach until it lifts again.
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw)
    let vLo = -Infinity, vHi = Infinity, wLo = -Infinity, wHi = Infinity
    const bound = (f: Sole, tau: number) => {
      if (tau <= 1e-4) return
      const o = (f.x - this.bx) * fx + (f.z - this.bz) * fz
      vHi = Math.min(vHi, (o + GAIT.reach) / tau)
      vLo = Math.max(vLo, (o - GAIT.reach) / tau)
      const dy = f.yaw - this.yaw
      wHi = Math.min(wHi, (dy + GAIT.yawReach) / tau)
      wLo = Math.max(wLo, (dy - GAIT.yawReach) / tau)
    }
    if (!this.lifted) {
      bound(this.feet[this.swing], (ds - this.s) * Ts)
      bound(this.feet[other], (1 - this.s + ds) * Ts)
    }
    else {
      bound(this.feet[other], (1 - this.s + ds) * Ts)
      bound(this.to, (1 - this.s) * Ts)
      bound(this.to, (2 - this.s + ds) * Ts)
    }
    const govern = (x: number, lo: number, hi: number) => {
      if (lo > hi) return (lo + hi) / 2
      return clamp(x, lo, hi)
    }
    // Sideways: the same bound across the hips. Only computed while side-
    // stepping, so ordinary walking runs exactly the arithmetic it always did.
    const uCmd = cmd.strafe ?? 0
    if (uCmd !== 0 || this.u !== 0) {
      const lx = Math.cos(this.yaw), lz = -Math.sin(this.yaw)
      let uLo = -Infinity, uHi = Infinity
      const boundU = (f: Sole, side: number, tau: number) => {
        if (tau <= 1e-4) return
        const o = (f.x - this.bx) * lx + (f.z - this.bz) * lz - side * LEG.hipW
        uHi = Math.min(uHi, (o + GAIT.latReach) / tau)
        uLo = Math.max(uLo, (o - GAIT.latReach) / tau)
      }
      const sw = this.swing === 0 ? 1 : -1
      if (!this.lifted) {
        boundU(this.feet[this.swing], sw, (ds - this.s) * Ts)
        boundU(this.feet[other], -sw, (1 - this.s + ds) * Ts)
      }
      else {
        boundU(this.feet[other], -sw, (1 - this.s + ds) * Ts)
        boundU(this.to, sw, (1 - this.s) * Ts)
      }
      const uT = govern(uCmd, uLo, uHi)
      this.u = approach(this.u, clamp(uT, -0.25, 0.25), (this.stagger > 0 ? GAIT.staggerAccel : GAIT.accel) * dt)
    }
    const vT = govern(cmd.speed, vLo, vHi)
    const wT = govern(cmd.yawRate, wLo, wHi)
    const gv = vT !== cmd.speed
    const gw = wT !== cmd.yawRate
    this.governed = gv || gw
    const acc = gv ? GAIT.govAccel : this.stagger > 0 ? GAIT.staggerAccel : GAIT.accel
    this.v = approach(this.v, clamp(vT, -0.25, 0.25), acc * dt)
    this.w = approach(this.w, clamp(wT, -2, 2), (gw ? GAIT.govYawAccel : GAIT.yawAccel) * dt)
    this.yaw += this.w * dt
    this.bx += Math.sin(this.yaw) * this.v * dt
    this.bz += Math.cos(this.yaw) * this.v * dt
    if (this.u !== 0) {
      this.bx += Math.cos(this.yaw) * this.u * dt
      this.bz -= Math.sin(this.yaw) * this.u * dt
    }

    // Phase clock.
    this.s += dt / Ts
    if (!this.lifted && this.s >= ds) this.planStep(cmd, Ts)
    if (this.lifted) {
      if (this.s >= 1) this.land(cmd)
      else this.swingFoot()
    }
    if (this.mode === 'walk') this.phi = (this.s + this.swing) / 2
  }

  /** Where the swing foot will land: under its hip at the middle of its coming stance, predicted. */
  private planStep(cmd: Command, Ts: number) {
    const ds = GAIT.ds
    const other = 1 - this.swing
    const tMid = (1 - this.s) * Ts + 0.5 * (1 + ds) * Ts
    const acc = this.stagger > 0 ? GAIT.staggerAccel : GAIT.accel
    let x = this.bx, z = this.bz, a = this.yaw, v = this.v, w = this.w, u = this.u, t = 0
    const uCmd = cmd.strafe ?? 0
    while (t < tMid - 1e-12) {
      const h = Math.min(0.01, tMid - t)
      v = approach(v, cmd.speed, acc * h)
      w = approach(w, cmd.yawRate, GAIT.yawAccel * h)
      a += w * h
      x += Math.sin(a) * v * h
      z += Math.cos(a) * v * h
      if (uCmd !== 0 || u !== 0) {
        u = approach(u, uCmd, acc * h)
        x += Math.cos(a) * u * h
        z -= Math.sin(a) * u * h
      }
      t += h
    }
    const side = this.swing === 0 ? 1 : -1
    let tx = x + Math.cos(a) * side * LEG.hipW
    let tz = z - Math.sin(a) * side * LEG.hipW
    // Keep clear of the stance foot and inside one step's length and turn.
    const st = this.feet[other]!
    const c = Math.cos(st.yaw), sn = Math.sin(st.yaw)
    const dx = tx - st.x, dz = tz - st.z
    let lat = dx * c - dz * sn
    let fwd = dx * sn + dz * c
    if (side * lat < GAIT.minSep) lat = side * GAIT.minSep
    fwd = clamp(fwd, -GAIT.maxStep, GAIT.maxStep)
    tx = st.x + lat * c + fwd * sn
    tz = st.z - lat * sn + fwd * c
    const tyaw = st.yaw + clamp(a - st.yaw, -GAIT.maxStepYaw, GAIT.maxStepYaw)

    Object.assign(this.from, this.feet[this.swing])
    this.to.x = tx
    this.to.y = 0
    this.to.z = tz
    this.to.yaw = tyaw
    this.lifted = true
    this.planted[this.swing] = false
  }

  /** Raised-cosine arc: eased along the ground, a smooth lift and set-down. The sole stays flat. */
  private swingFoot() {
    const u = clamp((this.s - GAIT.ds) / (1 - GAIT.ds), 0, 1)
    const k = (1 - Math.cos(Math.PI * u)) / 2
    const len = Math.hypot(this.to.x - this.from.x, this.to.z - this.from.z)
    const h = GAIT.swingH * (0.6 + 0.4 * Math.min(1, len / 0.06)) * (1 - Math.cos(TAU * u)) / 2
    const f = this.feet[this.swing]!
    f.x = this.from.x + (this.to.x - this.from.x) * k
    f.z = this.from.z + (this.to.z - this.from.z) * k
    f.yaw = this.from.yaw + (this.to.yaw - this.from.yaw) * k
    f.y = h
  }

  private land(cmd: Command) {
    const i = this.swing
    Object.assign(this.feet[i]!, this.to)
    this.planted[i] = true
    this.stanceId[i]++
    this.lifted = false
    this.pushed = 0
    this.s -= 1
    this.swing = (1 - i) as 0 | 1
    if (this.stagger > 0) {
      this.stagger--
      if (this.stagger === 0) this.recovering = true
    }
    // Stop only on a squared stance, with the body already at rest: the last
    // step is then the half step that brings the feet together.
    if (this.stagger === 0 && !moving(cmd) && Math.abs(this.v) < 0.003 && Math.abs(this.w) < 0.02 && Math.abs(this.u) < 0.003 && this.squared()) {
      this.mode = 'stand'
      this.phi = (1 + i) / 2
      this.v = this.w = this.u = 0
      this.s = 0
      this.recovering = false
      this.nextSwing = this.swing
    }
  }

  private squared() {
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i]!
      const side = i === 0 ? 1 : -1
      const nx = this.bx + Math.cos(this.yaw) * side * LEG.hipW
      const nz = this.bz - Math.sin(this.yaw) * side * LEG.hipW
      if (Math.hypot(f.x - nx, f.z - nz) > 0.004 || Math.abs(f.yaw - this.yaw) > 0.03) return false
    }
    return true
  }

  // ── Standing ────────────────────────────────────────────────────────────

  private standStep(dt: number) {
    this.v = this.w = this.u = 0
    if (this.posterMode) return
    // Idle weight shifts: lean onto one foot, then the other, then settle.
    this.shiftTimer -= dt
    if (this.shiftTimer <= 0) {
      const r = this.rand.next()
      const mag = this.rand.range(0.005, 0.01)
      this.shiftTarget = r < 0.35 ? 0 : r < 0.675 ? mag : -mag
      this.shiftTimer = this.rand.range(1.8, 4.5)
    }
  }

  // ── Hop (scripted) ─────────────────────────────────────────────────────

  private startHop() {
    this.mode = 'hop'
    this.hopQueued = false
    this.hopT = 0
    this.hopStage = 0
    for (let i = 0; i < 2; i++) Object.assign(this.hop0[i]!, this.feet[i])
    this.hopB.x = this.bx
    this.hopB.z = this.bz
    this.hopB.dx = Math.sin(this.yaw) * HOP.dist
    this.hopB.dz = Math.cos(this.yaw) * HOP.dist
  }

  private hopStep(dt: number) {
    this.hopT += dt
    const D0 = GAIT.standH - LEG.ankleH
    let t = this.hopT
    const stage = (n: number) => {
      const entered = this.hopStage < n
      this.hopStage = n
      return entered
    }
    if (t < HOP.crouchT) {
      // 1. Crouch: the soles stay planted, the pelvis sinks and tips forward.
      stage(0)
      const k = smooth(t / HOP.crouchT)
      this.hopY = LEG.ankleH + D0 + (HOP.crouchD - D0) * k
      this.hopPitch = HOP.pitch * k
      return
    }
    t -= HOP.crouchT
    if (t < HOP_PUSH_T) {
      // 2. Push: constant upward acceleration that ends at exactly the take-off speed.
      stage(1)
      this.hopY = LEG.ankleH + HOP.crouchD + 0.5 * HOP_ACC * t * t
      this.hopPitch = HOP.pitch * (1 - t / HOP_PUSH_T)
      return
    }
    t -= HOP_PUSH_T
    if (t < HOP_FLIGHT_T) {
      // 3. Flight: ballistic pelvis, legs tucking and re-extending, everything moving forward.
      if (stage(2)) {
        this.planted[0] = this.planted[1] = false
        this.neckP.v -= 1.5
      }
      const yb = HOP.v0 * t - 0.5 * HOP.g * t * t
      const k = t / HOP_FLIGHT_T
      this.hopY = LEG.ankleH + HOP.takeoffD + yb
      this.hopPitch = 0
      this.bx = this.hopB.x + this.hopB.dx * k
      this.bz = this.hopB.z + this.hopB.dz * k
      const fy = yb + HOP.tuck * Math.sin(Math.PI * k)
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i]!, f0 = this.hop0[i]!
        f.x = f0.x + this.hopB.dx * k
        f.z = f0.z + this.hopB.dz * k
        f.y = fy
      }
      return
    }
    t -= HOP_FLIGHT_T
    if (stage(3)) {
      // Touchdown on the squared stance, moved forward by HOP.dist.
      this.bx = this.hopB.x + this.hopB.dx
      this.bz = this.hopB.z + this.hopB.dz
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i]!, f0 = this.hop0[i]!
        f.x = f0.x + this.hopB.dx
        f.z = f0.z + this.hopB.dz
        f.y = 0
        f.yaw = f0.yaw
        this.planted[i] = true
        this.stanceId[i] = this.stanceId[i]! + 1
      }
      this.pitchKick.v += 1.0
      this.neckP.v -= 3
    }
    if (t < HOP.landT) {
      // 4. Squash: critically damped from the touchdown height and speed back to standing,
      // with the tiny residual at landT ramped out so the hand-off to standing is exact.
      const w = HOP.landOmega
      const x0 = HOP.takeoffD - D0
      const v0 = -HOP.v0
      const x = (tt: number) => (x0 + (v0 + w * x0) * tt) * Math.exp(-w * tt)
      this.hopY = LEG.ankleH + D0 + x(t) - x(HOP.landT) * (t / HOP.landT)
      return
    }
    this.mode = 'stand'
    this.hopY = GAIT.standH
  }

  // ── Neck and head ───────────────────────────────────────────────────────

  private lookStep(dt: number) {
    let ty = 0
    let tp = 0
    if (this.asleep) {
      ty = 0
      tp = -GAIT.pitchLimit
    }
    else if (this.look) {
      const ex = this.cur.x + Math.sin(this.yaw) * EYE_Z
      const ez = this.cur.z + Math.cos(this.yaw) * EYE_Z
      const dx = this.look.x - ex
      const dz = this.look.z - ez
      const dy = this.look.y - (this.cur.y + EYE_Y)
      const fwd = dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw)
      const left = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw)
      ty = Math.atan2(left, fwd)
      tp = Math.atan2(dy, Math.hypot(fwd, left))
    }
    else if (!this.posterMode) {
      // Idle life: glances, and the odd peck at the ground when standing.
      this.glanceTimer -= dt
      this.peckT -= dt
      if (this.glanceTimer <= 0) {
        if (this.mode === 'stand') {
          if (this.rand.next() < 0.22) {
            this.peckT = 0.45
            this.glanceYaw = this.rand.range(-0.3, 0.3)
          }
          else {
            this.glanceYaw = this.rand.range(-1.0, 1.0)
            this.glancePitch = this.rand.range(-0.3, 0.12)
          }
          this.glanceTimer = this.rand.range(1.0, 3.2)
        }
        else {
          this.glanceYaw = this.rand.range(-0.45, 0.45)
          this.glancePitch = this.rand.range(-0.2, 0.05)
          this.glanceTimer = this.rand.range(1.5, 3.5)
        }
      }
      // Walking, the head also leads into the turn.
      ty = this.glanceYaw * (this.mode === 'walk' ? 0.6 : 1) + this.w * 0.25
      tp = this.peckT > 0 ? -GAIT.pitchLimit : this.glancePitch
    }
    ty = clamp(ty, -GAIT.yawLimit, GAIT.yawLimit)
    tp = clamp(tp, -GAIT.pitchLimit, GAIT.pitchLimit)
    if (this.posterMode) {
      this.neckY.x = this.headY.x = ty
      this.neckP.x = this.headP.x = tp
      this.neckY.v = this.neckP.v = this.headY.v = this.headP.v = 0
      return
    }
    this.neckY.step(ty, GAIT.neckOmega, 1, dt)
    this.neckP.step(tp, GAIT.neckOmega, 1, dt)
    this.neckY.limit(GAIT.yawLimit)
    this.neckP.limit(GAIT.pitchLimit)
    // The head chases the neck with a lighter, slightly underdamped spring: it lags, then settles.
    this.headY.step(this.neckY.x, GAIT.headOmega, GAIT.headZeta, dt)
    this.headP.step(this.neckP.x, GAIT.headOmega, GAIT.headZeta, dt)
    this.headY.limit(GAIT.yawLimit)
    this.headP.limit(GAIT.pitchLimit)
  }

  // ── Pose ────────────────────────────────────────────────────────────────

  private compose() {
    const p = this.cur
    if (this.mode === 'fall') {
      // The fall owns the pelvis (no gait clamps: it is lying down); the look springs carry on.
      const f = this.fall
      p.x = f.x
      p.y = f.y
      p.z = f.z
      p.yaw = this.yaw
      p.pitch = f.pitch
      p.roll = f.roll
      for (let i = 0; i < 2; i++) Object.assign(p.feet[i]!, this.feet[i])
      p.neckYaw = this.neckY.x
      p.neckPitch = this.neckP.x
      p.headYaw = this.headY.x
      p.headPitch = this.headP.x
      return
    }
    const c = this.phi - GAIT.ds / 4
    const sway = -GAIT.sway * Math.sin(TAU * c) * this.g
    const bobN = -Math.cos(2 * TAU * c) * this.g
    // Asleep, the breath is slower and deeper (and the head hangs: lookStep).
    const breath = this.posterMode
      ? 0
      : this.sleepK !== 0
        ? 0.004 * this.sleepK * Math.sin(TAU * this.t / 3.6) * (1 - this.g)
        : 0.0012 * Math.sin(TAU * this.t / 2.8) * (1 - this.g)
    const lat = sway + this.shift.x
    p.yaw = this.yaw
    p.x = this.bx + Math.cos(this.yaw) * lat
    p.z = this.bz - Math.sin(this.yaw) * lat
    p.y = (this.mode === 'hop' ? this.hopY : GAIT.standH) + GAIT.bob * bobN + (this.mode === 'stand' ? breath : 0)
    // Asleep it sinks a centimetre into its knees; waking, it rises back (eased, in any mode).
    if (this.sleepK !== 0) p.y -= 0.012 * this.sleepK
    // Waddle: the top of the body leans over the foot carrying the weight.
    p.roll = clamp(-lat * GAIT.rollMax / GAIT.sway, -GAIT.rollLimit, GAIT.rollLimit)
    const hopPitch = this.mode === 'hop' ? this.hopPitch : 0
    p.pitch = clamp(GAIT.pitchPerSpeed * this.v - GAIT.nod * bobN + this.pitchKick.x + hopPitch, -GAIT.pitchMax, GAIT.pitchMax)
    for (let i = 0; i < 2; i++) Object.assign(p.feet[i]!, this.feet[i])
    p.neckYaw = this.neckY.x
    p.neckPitch = this.neckP.x
    p.headYaw = this.headY.x
    p.headPitch = this.headP.x
  }

  /** Full internal state, for determinism tests. */
  snapshot() {
    return JSON.stringify({
      cur: this.cur, b: [this.bx, this.bz, this.yaw, this.v, this.w, this.u], mode: this.mode, stag: [this.stagger, this.stagV, this.stagU, this.pushed, this.asleep], fall: [this.fall.phase, this.fall.phi, this.fall.phid, this.fall.x, this.fall.y, this.fall.z, this.pull],
      s: this.s, swing: this.swing, phi: this.phi, g: this.g, t: this.t,
      springs: [this.shift, this.pitchKick, this.neckY, this.neckP, this.headY, this.headP].map(k => [k.x, k.v]),
      hop: [this.hopT, this.hopY, this.hopStage, this.hopPitch], timers: [this.shiftTimer, this.shiftTarget, this.glanceTimer, this.glanceYaw, this.glancePitch, this.peckT],
      feet: this.feet, planted: this.planted, stanceId: this.stanceId,
    })
  }
}
