import { rng, type Rng } from '../../core/rng'
import type { Collider, ContactOther, Normal } from '../contact'
import { Spring, bodyRotation, clamp, mat3, rotY, smooth, vec3, type Mat3 } from '../dog/kin'
import { Script, Support, newScriptPose, type Key, type ScriptPose } from '../dog/script'
import { Stepper, moving, type Command, type StepperSpec } from '../dog/stepper'
import { GRAB, grabForce, type Force3 } from '../grab'
import { ARM, LEG, fkArm, fkLeg, newSolution, solveLeg } from './ik'

/**
 * Makey's behaviour: Maker Faire's red robot as a friendly host. PROCEDURAL
 * and KINEMATIC; pure TypeScript (the tests run it headless).
 *
 * - WALK: a two-foot step cycle (dog/stepper.ts) with big flat feet that
 *   never slide, a sway over the stance foot with a waddle roll, a bob, a
 *   lean into its speed, and an arm swing opposite the legs.
 * - WAVE HI: when something it is looking at holds still near it (the
 *   pointer resting, another robot), it raises the arm on that side and
 *   waves from the elbow with a wrist wag, tilts its head and its eyes
 *   brighten. Cooldown so it is a greeting, not a tic. wave() does it on
 *   demand; react('tap') is a big two-arm wave and a hop.
 * - FALL and GET-UP are SCRIPTED (dog/script.ts): it twists to fall along
 *   its own axis, tips over its heels (or toes), hits, rebounds, lies a beat
 *   with its eyes dimmed; then -- on its back -- sits up, pulls its feet in
 *   and pushes off its hands into a squat; on its front it pushes up onto
 *   its knees, then into a squat. It stands with its feet planted, dusts
 *   itself off, and waves. Its body always rests on its lowest points.
 */

export const MAKEY_GAIT = {
  standH: LEG.ankleH + 0.8 * (LEG.L1 + LEG.L2),
  bob: 0.003,
  sway: 0.009,
  rollMax: 4 * Math.PI / 180,
  pitchPerSpeed: 5 * Math.PI / 180 / 0.15,
  armSwing: 0.4,
  neckYawLimit: 1.0,
  neckPitchLimit: 0.45,
  /** Wave: how long the target must hold still (s), how near (m), and the cooldown (s). */
  waveHold: 0.7,
  waveNear: 1.6,
  waveCool: 7,
  waveT: 1.7,
  dustT: 1.1,
}

export const MAKEY_STEP: StepperSpec = {
  feet: [{ x: LEG.hipW, z: 0 }, { x: -LEG.hipW, z: 0 }],
  groups: [[0], [1]],
  stepTime: 0.3,
  staggerStepTime: 0.2,
  ds: 0.2,
  swingH: 0.02,
  maxSpeed: 0.15,
  maxBack: 0.08,
  maxYawRate: 1.4,
  maxStrafe: 0.08,
  accel: 0.45,
  yawAccel: 4,
  govAccel: 2.5,
  govYawAccel: 12,
  staggerAccel: 3,
  reach: 0.04,
  latReach: 0.018,
  yawReach: 0.5,
  maxStep: 0.07,
  maxStepYaw: 0.5,
}

export const HOP = {
  crouchT: 0.18,
  crouchH: LEG.ankleH + 0.6 * (LEG.L1 + LEG.L2),
  takeoffH: LEG.ankleH + 0.93 * (LEG.L1 + LEG.L2),
  v0: 0.8,
  g: 9.81,
  tuck: 0.015,
  landT: 0.5,
  landOmega: 13,
}
const HOP_PUSH_T = 2 * (HOP.takeoffH - HOP.crouchH) / HOP.v0
const HOP_ACC = HOP.v0 * HOP.v0 / (2 * (HOP.takeoffH - HOP.crouchH))
const HOP_FLIGHT_T = 2 * HOP.v0 / HOP.g
export const HOP_TOTAL = HOP.crouchT + HOP_PUSH_T + HOP_FLIGHT_T + HOP.landT

export const MAKEY_SHAPE = {
  mass: 1.6,
  bodyR: 0.075,
  headR: 0.065,
  footR: 0.03,
  replant: 0.005,
  stumbleMin: 0.035,
  fallImpact: 0.45,
  // Grab thresholds are fractions of the hand's strength (GRAB.maxForce), so
  // they keep their meaning if the shared grab spring is retuned: a pull
  // well short of a full yank walks it along, a full yank held a moment
  // knocks it over.
  dragWalk: 0.13 * GRAB.maxForce,
  fallForce: 0.65 * GRAB.maxForce,
  fallHold: 0.15,
}

/** Joint order: 0-5 left leg, 6-11 right leg (ik.JOINTS order), 12-16 left arm, 17-21 right arm. */
export const NQ = 22
export const ARM_L = 12
export const ARM_R = 17

export interface Sole { x: number, y: number, z: number, yaw: number }
export interface MakeyPose {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
  feet: [Sole, Sole]
  /** Arms always come from here; legs blend IK (k = 0) with these (k = 1). */
  q: number[]
  k: number
  neckYaw: number
  neckPitch: number
  headTilt: number
  /** Eye brightness 0..1. */
  glow: number
}

export function newPose(): MakeyPose {
  return {
    x: 0, y: MAKEY_GAIT.standH, z: 0, yaw: 0, pitch: 0, roll: 0,
    feet: [{ x: 0, y: 0, z: 0, yaw: 0 }, { x: 0, y: 0, z: 0, yaw: 0 }], q: new Array(NQ).fill(0), k: 0,
    neckYaw: 0, neckPitch: 0, headTilt: 0, glow: 0.7,
  }
}

export function copyPose(a: MakeyPose, b: MakeyPose) {
  b.x = a.x; b.y = a.y; b.z = a.z; b.yaw = a.yaw; b.pitch = a.pitch; b.roll = a.roll
  for (let i = 0; i < 2; i++) Object.assign(b.feet[i]!, a.feet[i])
  for (let i = 0; i < NQ; i++) b.q[i] = a.q[i]!
  b.k = a.k; b.neckYaw = a.neckYaw; b.neckPitch = a.neckPitch; b.headTilt = a.headTilt; b.glow = a.glow
}

export function lerpPose(a: MakeyPose, b: MakeyPose, t: number, o: MakeyPose) {
  const l = (p: number, q: number) => p + (q - p) * t
  o.x = l(a.x, b.x); o.y = l(a.y, b.y); o.z = l(a.z, b.z)
  o.yaw = l(a.yaw, b.yaw); o.pitch = l(a.pitch, b.pitch); o.roll = l(a.roll, b.roll)
  for (let i = 0; i < 2; i++) {
    const fa = a.feet[i]!, fb = b.feet[i]!, fo = o.feet[i]!
    fo.x = l(fa.x, fb.x); fo.y = l(fa.y, fb.y); fo.z = l(fa.z, fb.z); fo.yaw = l(fa.yaw, fb.yaw)
  }
  for (let i = 0; i < NQ; i++) o.q[i] = l(a.q[i]!, b.q[i]!)
  o.k = l(a.k, b.k); o.neckYaw = l(a.neckYaw, b.neckYaw); o.neckPitch = l(a.neckPitch, b.neckPitch)
  o.headTilt = l(a.headTilt, b.headTilt); o.glow = l(a.glow, b.glow)
  return o
}

const PR = mat3(), SR = mat3(), PP = vec3(), SP = vec3()
const SOLS = [newSolution(), newSolution()]
const LEG_KEYS = ['hipYaw', 'hipRoll', 'hipPitch', 'knee', 'anklePitch', 'ankleRoll'] as const

/** All 22 joints for a pose: leg IK from the soles blended with scripted legs by k; arms as given. */
export function poseJoints(p: MakeyPose, out: number[]) {
  const R = bodyRotation(p.yaw, p.pitch, p.roll, PR)
  PP[0] = p.x; PP[1] = p.y; PP[2] = p.z
  for (let i = 0; i < 2; i++) {
    const o = i * 6
    if (p.k < 1) {
      const f = p.feet[i]!
      SP[0] = f.x; SP[1] = f.y; SP[2] = f.z
      const s = solveLeg(PP, R, i === 0 ? 1 : -1, SP, rotY(f.yaw, SR), SOLS[i])
      for (let j = 0; j < 6; j++) {
        const a = s[LEG_KEYS[j]!]
        out[o + j] = a + (p.q[o + j]! - a) * p.k
      }
    }
    else for (let j = 0; j < 6; j++) out[o + j] = p.q[o + j]!
  }
  for (let j = 12; j < NQ; j++) out[j] = p.q[j]!
  return out
}

/** Arm targets: [shPitch, shRoll, elX, elZ, wrist] for the left arm; the right mirrors roll terms. */
type Arm5 = [number, number, number, number, number]
const mirror = (a: Arm5): Arm5 => [a[0], -a[1], a[2], -a[3], -a[4]]

const ARM_REST: Arm5 = [0.05, 0.12, -0.25, 0, 0]
/** The greeting: arm up and out, forearm upright, hand open toward the viewer. */
const ARM_WAVE: Arm5 = [-0.25, 2.25, -0.15, 0.6, 0]

export type MakeyMode = 'stand' | 'walk' | 'hop' | 'fall'

export class MakeyGait {
  readonly cur = newPose()
  readonly prev = newPose()
  readonly stepper = new Stepper(MAKEY_STEP)
  mode: MakeyMode = 'stand'
  asleep = false
  touchdowns = 0
  thuds = 0
  hops = 0
  waves = 0
  vx = 0
  vz = 0
  /** 0 body, 1 head, 2 left foot, 3 right foot. */
  readonly colliders: Collider[] = [0, 1, 2, 3].map(k => ({
    x: 0, z: 0, r: k === 0 ? MAKEY_SHAPE.bodyR : k === 1 ? MAKEY_SHAPE.headR : MAKEY_SHAPE.footR, vx: 0, vz: 0, fixed: k >= 2,
  }))
  readonly force: Force3 = { x: 0, y: 0, z: 0 }
  /** Wave greetings fire by themselves when a look target holds still nearby. */
  autoWave = true

  private t = 0
  private readonly rand: Rng
  private readonly cmd: Command = { speed: 0, yawRate: 0, strafe: 0 }
  private shift = new Spring()
  private shiftTarget = 0
  private shiftTimer = 2
  private pitchKick = new Spring()
  private rollKick = new Spring()
  private neckY = new Spring()
  private neckP = new Spring()
  private tilt = new Spring()
  private glow = new Spring()
  private look: { x: number, y: number, z: number } | null = null
  private lookHeld = 0
  private lookRef = { x: 0, y: 0, z: 0 }
  private glanceT = 1
  private glanceY = 0
  private glanceP = 0
  // Arms: current joint values (springs per joint), wave / dust overlays.
  private readonly arm = Array.from({ length: 10 }, () => new Spring())
  private waveT = 0
  private waveSide = 1
  private waveBoth = false
  private waveCool = 0
  private dustT = 0
  // Hop.
  private hopQueued = false
  private hopT = 0
  private hopStage = 0
  private hopY = MAKEY_GAIT.standH
  // Stagger / contact.
  private recovering = false
  private pushed = 0
  // Fall.
  readonly script = new Script(NQ)
  private readonly support = new Support(40)
  private readonly supPts = new Float64Array(120)
  private readonly supRad = new Float64Array(40)
  private fallYaw = 0
  private fallFront = false
  private riseOn = false
  private riseY0 = 0
  private riseP0 = 0
  private riseR0 = 0
  private readonly riseQ = new Array(12).fill(0)
  private afterFall = false
  // Grab.
  private grabbed = false
  private readonly grabLocal = vec3()
  private readonly grabPrev = vec3()
  private readonly grabTarget = vec3()
  private hardPull = 0

  constructor(seed: number, readonly posterMode = false) {
    this.rand = rng(seed)
    for (let s = 0; s < 2; s++) {
      const a = s === 0 ? ARM_REST : mirror(ARM_REST)
      for (let j = 0; j < 5; j++) this.arm[s * 5 + j]!.x = a[j]!
    }
    this.glow.x = 0.7
    this.placeAt(0, 0, 0)
  }

  get busy() {
    return this.mode === 'hop' || this.mode === 'fall' || this.hopQueued || this.stepper.stagger > 0 || this.recovering || this.dustT > 0
  }

  get fallen() {
    return this.mode === 'fall'
  }

  get heading() {
    return this.mode === 'fall' ? this.cur.yaw : this.stepper.yaw
  }

  /** True while an arm is up greeting someone. */
  get waving() {
    return this.waveT > 0
  }

  placeAt(x: number, z: number, heading: number) {
    this.stepper.placeAt(x, z, heading)
    this.mode = 'stand'
    this.hopQueued = false
    this.recovering = false
    this.pushed = 0
    this.dustT = 0
    this.script.i = this.script.keys.length
    this.compose()
    copyPose(this.cur, this.prev)
    this.vx = this.vz = 0
    this.updateColliders()
  }

  lookAt(p: { x: number, y: number, z: number } | null) {
    if (p && this.look && Math.hypot(p.x - this.lookRef.x, p.y - this.lookRef.y, p.z - this.lookRef.z) < 0.03) {
      this.look.x = p.x; this.look.y = p.y; this.look.z = p.z
      return
    }
    this.look = p ? { x: p.x, y: p.y, z: p.z } : null
    this.lookHeld = 0
    if (p) {
      this.lookRef.x = p.x; this.lookRef.y = p.y; this.lookRef.z = p.z
    }
  }

  /** Wave hi. side: +1 left arm, -1 right arm, 0 both (the big one). */
  wave(side: number) {
    if (this.mode === 'fall' || this.asleep) return
    this.waveBoth = side === 0
    this.waveSide = side >= 0 ? 1 : -1
    // A poster holds one frame of the wave: arm up, mid-wag.
    this.waveT = this.posterMode ? MAKEY_GAIT.waveT * 0.5 : MAKEY_GAIT.waveT
    this.waveCool = MAKEY_GAIT.waveCool
    this.waves++
    this.tilt.v += (this.waveBoth ? 0 : this.waveSide) * 2
  }

  react(kind: 'tap' | 'shove' | 'tumble') {
    if (this.posterMode || this.mode === 'fall') return
    if (kind === 'tumble') {
      const a = this.rand.range(0, Math.PI * 2)
      this.startFall(Math.sin(a), Math.cos(a))
      return
    }
    if (this.busy) return
    if (kind === 'tap') {
      this.wave(0)
      this.hopQueued = true
      return
    }
    this.pitchKick.v -= 1.4
    this.stepper.stumble(-0.18, 0, 3)
  }

  setSleep(on: boolean) {
    if (this.asleep && !on && !this.posterMode) {
      this.pitchKick.v -= 1.2
      this.neckP.v += 4
      this.glow.v += 8
    }
    this.asleep = on
  }

  setPaused(paused: boolean) {
    if (paused) {
      this.hopQueued = false
      this.look = null
      this.grab(null)
    }
  }

  grab(at: { x: number, y: number, z: number } | null) {
    if (!at || this.posterMode) {
      this.grabbed = false
      this.hardPull = 0
      return
    }
    const p = this.cur
    const R = bodyRotation(p.yaw, p.pitch, p.roll, PR)
    const dx = at.x - p.x, dy = at.y - p.y, dz = at.z - p.z
    this.grabLocal[0] = R[0] * dx + R[3] * dy + R[6] * dz
    this.grabLocal[1] = R[1] * dx + R[4] * dy + R[7] * dz
    this.grabLocal[2] = R[2] * dx + R[5] * dy + R[8] * dz
    this.grabPrev[0] = this.grabTarget[0] = at.x
    this.grabPrev[1] = this.grabTarget[1] = at.y
    this.grabPrev[2] = this.grabTarget[2] = at.z
    this.grabbed = true
    this.hardPull = 0
  }

  dragTo(t: { x: number, y: number, z: number }) {
    this.grabTarget[0] = t.x; this.grabTarget[1] = t.y; this.grabTarget[2] = t.z
  }

  // ── Step ────────────────────────────────────────────────────────────────

  step(dt: number, cmdIn: Command) {
    copyPose(this.cur, this.prev)
    this.t += dt
    const x0 = this.cur.x, z0 = this.cur.z
    if (this.grabbed) this.pull(dt)
    if (this.waveCool > 0) this.waveCool -= dt
    if (this.mode === 'fall') this.fallStep(dt)
    else {
      const cmd = this.cmd
      if (this.posterMode) cmd.speed = cmd.yawRate = cmd.strafe = 0
      else {
        cmd.speed = cmdIn.speed
        cmd.yawRate = cmdIn.yawRate
        cmd.strafe = cmdIn.strafe ?? 0
      }
      const st = this.stepper
      const hold = this.hopQueued || this.recovering || this.asleep || this.dustT > 0
      if (this.mode === 'hop') this.hopStep(dt)
      else {
        const stag = st.stagger
        st.step(dt, cmd, hold)
        if (stag > 0 && st.stagger === 0) this.recovering = true
        if (this.recovering && st.mode === 'stand') this.recovering = false
        if (st.landed >= 0) {
          st.landed = -1
          this.touchdowns++
          this.pushed = 0
        }
        this.mode = st.mode
        if (this.hopQueued && st.mode === 'stand') this.startHop()
      }
      this.pitchKick.step(0, 10, 0.45, dt)
      this.rollKick.step(0, 10, 0.45, dt)
      this.idleStep(dt)
    }
    this.lookStep(dt)
    this.armStep(dt)
    if (this.mode !== 'fall') this.compose()
    this.vx = (this.cur.x - x0) / dt
    this.vz = (this.cur.z - z0) / dt
    this.updateColliders()
  }

  private idleStep(dt: number) {
    if (this.posterMode || this.mode !== 'stand') {
      this.shift.step(0, 3.5, 1, dt)
      return
    }
    this.shiftTimer -= dt
    if (this.shiftTimer <= 0) {
      const r = this.rand.next()
      const mag = this.rand.range(0.004, 0.008)
      this.shiftTarget = r < 0.35 ? 0 : r < 0.675 ? mag : -mag
      this.shiftTimer = this.rand.range(1.8, 4.5)
    }
    this.shift.step(this.shiftTarget, 3.5, 1, dt)
  }

  // ── Hop (scripted) ──────────────────────────────────────────────────────

  private startHop() {
    this.mode = 'hop'
    this.hopQueued = false
    this.hopT = 0
    this.hopStage = 0
    this.hops++
  }

  private hopStep(dt: number) {
    const st = this.stepper
    this.hopT += dt
    let t = this.hopT
    const H = MAKEY_GAIT.standH
    if (t < HOP.crouchT) {
      this.hopY = H + (HOP.crouchH - H) * smooth(t / HOP.crouchT)
      return
    }
    t -= HOP.crouchT
    if (t < HOP_PUSH_T) {
      this.hopY = HOP.crouchH + 0.5 * HOP_ACC * t * t
      return
    }
    t -= HOP_PUSH_T
    if (t < HOP_FLIGHT_T) {
      if (this.hopStage < 2) {
        this.hopStage = 2
        st.planted[0] = st.planted[1] = false
        this.neckP.v += 2
      }
      const yb = HOP.v0 * t - 0.5 * HOP.g * t * t
      this.hopY = HOP.takeoffH + yb
      const fy = yb + HOP.tuck * Math.sin(Math.PI * t / HOP_FLIGHT_T)
      st.feet[0]!.y = st.feet[1]!.y = fy
      return
    }
    t -= HOP_FLIGHT_T
    if (this.hopStage < 3) {
      this.hopStage = 3
      for (let i = 0; i < 2; i++) {
        st.feet[i]!.y = 0
        st.planted[i] = true
        st.stanceId[i]!++
      }
      this.touchdowns++
      this.pitchKick.v += 0.8
      this.neckP.v -= 2
    }
    if (t < HOP.landT) {
      const w = HOP.landOmega
      const x0 = HOP.takeoffH - H
      const v0 = -HOP.v0
      const x = (tt: number) => (x0 + (v0 + w * x0) * tt) * Math.exp(-w * tt)
      this.hopY = H + x(t) - x(HOP.landT) * (t / HOP.landT)
      return
    }
    this.hopY = H
    this.mode = 'stand'
  }

  // ── Contact and grab ────────────────────────────────────────────────────

  updateColliders() {
    const cs = this.colliders
    const p = this.cur
    const down = this.mode === 'fall'
    const R = bodyRotation(p.yaw, p.pitch, p.roll, PR)
    // Body and head circles sit where the torso and head actually are (they
    // move out along the ground when it lies down).
    const bx = p.x + R[1] * 0.06, bz = p.z + R[7] * 0.06
    const hx = p.x + R[1] * 0.17, hz = p.z + R[7] * 0.17
    const set = (c: Collider, x: number, z: number, r: number, y0: number, y1: number) => {
      c.x = x; c.z = z; c.r = r; c.y0 = y0; c.y1 = y1; c.vx = this.vx; c.vz = this.vz
      c.fixed = this.mode === 'hop' && this.hopStage !== 2
    }
    set(cs[0]!, bx, bz, MAKEY_SHAPE.bodyR, down ? 0 : p.y - 0.01, down ? 0.15 : p.y + 0.13)
    set(cs[1]!, hx, hz, MAKEY_SHAPE.headR, down ? 0 : p.y + 0.12, down ? 0.15 : p.y + 0.24)
    const st = this.stepper
    for (let i = 0; i < 2; i++) {
      const c = cs[2 + i]!
      const f = st.feet[i]!
      c.r = down ? 0 : MAKEY_SHAPE.footR
      c.x = f.x + Math.sin(f.yaw) * 0.008
      c.z = f.z + Math.cos(f.yaw) * 0.008
      c.fixed = st.planted[i]!
      c.vx = c.vz = 0
      c.y0 = f.y
      c.y1 = f.y + 0.04
    }
  }

  collide(n: Normal, depth: number, relSpeed: number, _other: ContactOther, part: number) {
    const c = this.colliders[part]
    if (this.mode === 'fall') {
      if (depth > 0) {
        this.cur.x += n.x * depth
        this.cur.z += n.z * depth
        this.support.shift(n.x * depth, n.z * depth)
      }
      this.updateColliders()
      return
    }
    const st = this.stepper
    if (depth > 0 && c && !c.fixed) {
      if (part >= 2 && st.lifted) st.reaim(part - 2, n.x * depth, n.z * depth)
      else {
        st.shiftBody(n.x * depth, n.z * depth)
        if (this.mode === 'hop') for (const f of st.feet) { f.x += n.x * depth; f.z += n.z * depth }
        this.pushed += depth
        this.compose()
      }
    }
    if (relSpeed > MAKEY_SHAPE.fallImpact && !this.posterMode) this.startFall(n.x, n.z)
    else if (relSpeed > MAKEY_SHAPE.stumbleMin || this.pushed > MAKEY_SHAPE.replant) this.stumble(n.x, n.z, relSpeed)
    this.updateColliders()
  }

  private stumble(nx: number, nz: number, impact: number) {
    if (this.posterMode || this.mode === 'hop') return
    const st = this.stepper
    const speed = clamp(0.07 + 0.6 * impact, 0.07, 0.22)
    if (st.stagger > 0 && speed <= Math.hypot(st.stagV, st.stagU) + 1e-9) return
    const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw)
    const along = nx * fx + nz * fz
    const left = nx * fz - nz * fx
    this.hopQueued = false
    this.pushed = 0
    const k = clamp(impact / 0.2, 0.3, 1.5)
    this.pitchKick.v += 1.6 * k * along
    this.rollKick.v -= 1.6 * k * left
    this.neckP.v += 2.5 * k
    st.stumble(speed * along, speed * left, impact > 0.25 ? 3 : 2)
  }

  private pull(dt: number) {
    const p = this.cur
    const R = bodyRotation(p.yaw, p.pitch, p.roll, PR)
    const g = this.grabLocal
    const wx = p.x + R[0] * g[0] + R[1] * g[1] + R[2] * g[2]
    const wy = p.y + R[3] * g[0] + R[4] * g[1] + R[5] * g[2]
    const wz = p.z + R[6] * g[0] + R[7] * g[1] + R[8] * g[2]
    const f = grabForce(wx, wy, wz, (wx - this.grabPrev[0]) / dt, (wy - this.grabPrev[1]) / dt, (wz - this.grabPrev[2]) / dt,
      this.grabTarget[0], this.grabTarget[1], this.grabTarget[2], this.force)
    this.grabPrev[0] = wx; this.grabPrev[1] = wy; this.grabPrev[2] = wz
    if (this.mode === 'fall' || this.mode === 'hop') return
    const fh = Math.hypot(f.x, f.z)
    const st = this.stepper
    const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw)
    const nx = fh > 1e-6 ? f.x / fh : 0, nz = fh > 1e-6 ? f.z / fh : 0
    const along = nx * fx + nz * fz
    const left = nx * fz - nz * fx
    this.pitchKick.v += 0.7 * fh * along * dt
    this.rollKick.v -= 0.7 * fh * left * dt
    if (fh > MAKEY_SHAPE.fallForce) this.hardPull += dt
    else this.hardPull = Math.max(0, this.hardPull - dt)
    if (this.hardPull > MAKEY_SHAPE.fallHold) {
      this.startFall(nx, nz)
      return
    }
    if (fh > MAKEY_SHAPE.dragWalk) {
      const speed = clamp(0.03 * fh, 0.06, 0.2)
      if (st.stagger === 0 || speed > Math.hypot(st.stagV, st.stagU) + 0.02) st.stumble(speed * along, speed * left, 2)
    }
  }

  // ── Fall and get-up (scripted) ──────────────────────────────────────────

  /** Knocked over toward world direction (nx, nz). */
  startFall(nx: number, nz: number) {
    if (this.mode === 'fall' || this.posterMode) return
    const p = this.cur
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw)
    const along = nx * fx + nz * fz
    const left = nx * fz - nz * fx
    // It falls along its own axis, twisting toward the push on the way down.
    const rel = Math.atan2(left, along)
    const front = Math.abs(rel) < Math.PI / 2
    const twist = clamp(front ? rel : Math.atan2(Math.sin(rel - Math.PI), Math.cos(rel - Math.PI)), -0.9, 0.9)
    const from = newScriptPose(NQ)
    from.pitch = p.pitch
    from.roll = p.roll
    poseJoints(p, from.q)
    this.fallYaw = p.yaw
    this.fallFront = front
    p.k = 1
    for (let i = 0; i < NQ; i++) p.q[i] = from.q[i]!
    this.script.start(front ? frontKeys(twist) : backKeys(twist), from)
    this.support.reset()
    this.mode = 'fall'
    this.hopQueued = false
    this.recovering = false
    this.grabbed = false
    this.riseOn = false
    this.waveT = 0
    this.dustT = 0
    this.stepper.stagger = 0
    this.stepper.planted[0] = this.stepper.planted[1] = false
    this.neckP.v += 3
  }

  private fallStep(dt: number) {
    const sc = this.script
    const prevTag = sc.tag
    sc.step(dt)
    const tag = sc.tag
    if (tag !== prevTag && prevTag === 'topple') this.thuds++
    const p = this.cur
    const sp = sc.pose
    // Arms always follow the script, through the arm springs (armStep reads targets from here).
    if (tag === 'rise' || sc.done) {
      if (!this.riseOn) this.beginRise()
      const u = sc.done ? 1 : sc.u
      const e = smooth(u)
      p.y = this.riseY0 + (MAKEY_GAIT.standH - this.riseY0) * e
      p.pitch = this.riseP0 * (1 - e)
      p.roll = this.riseR0 * (1 - e)
      p.k = 1 - smooth(Math.min(1, u / 0.3))
      for (let i = 0; i < 12; i++) p.q[i] = this.riseQ[i]!
      if (sc.done) this.endFall()
      return
    }
    p.yaw = this.fallYaw + sp.yaw
    p.pitch = sp.pitch
    p.roll = sp.roll
    for (let i = 0; i < 12; i++) p.q[i] = sp.q[i]!
    p.k = 1
    const R = bodyRotation(p.yaw, p.pitch, p.roll, PR)
    const n = this.supportPoints(sp.q)
    this.support.place(R, this.supPts, this.supRad, n, p, sp.lift)
    this.feetFromJoints(R, sp.q)
  }

  private supportPoints(q: number[]) {
    let n = 0
    const P = this.supPts, Rd = this.supRad
    const add = (x: number, y: number, z: number, r: number) => {
      P[n * 3] = x; P[n * 3 + 1] = y; P[n * 3 + 2] = z; Rd[n] = r
      n++
    }
    // Torso box corners, the seat, the head (a dome: front, back, top, sides).
    for (const x of [-0.055, 0.055]) for (const y of [0.012, 0.118]) for (const z of [-0.036, 0.036]) add(x, y, z, 0.012)
    add(0, 0.01, -0.03, 0.02)
    for (const [x, y, z] of [[0, 0.17, 0.045], [0, 0.17, -0.045], [0, 0.215, 0], [0.05, 0.16, 0], [-0.05, 0.16, 0]] as const) add(x, y, z, 0.022)
    // Legs: knees and the sole corners.
    const O: [number, number, number] = [0, 0, 0]
    for (let s = 0; s < 2; s++) {
      const f = fkLeg(O, IDENT, s === 0 ? 1 : -1, q, s * 6)
      add(f.knee[0], f.knee[1], f.knee[2], 0.02)
      for (const [cx, cz] of [[LEG.footHalfW, LEG.toe], [-LEG.footHalfW, LEG.toe], [LEG.footHalfW, LEG.heel], [-LEG.footHalfW, LEG.heel]] as const) {
        const R = f.soleR
        add(f.sole[0] + R[0] * cx + R[2] * cz, f.sole[1] + R[3] * cx + R[5] * cz, f.sole[2] + R[6] * cx + R[8] * cz, 0.004)
      }
      // Arms: elbows and hands (the hands are what it pushes off with).
      fkArm(s === 0 ? 1 : -1, q, s === 0 ? ARM_L : ARM_R, ARMPTS)
      add(ARMPTS.elbow[0], ARMPTS.elbow[1], ARMPTS.elbow[2], 0.017)
      add(ARMPTS.hand[0], ARMPTS.hand[1], ARMPTS.hand[2], 0.016)
    }
    return n
  }

  private feetFromJoints(R: Mat3, q: number[]) {
    const p = this.cur
    const P: [number, number, number] = [p.x, p.y, p.z]
    for (let s = 0; s < 2; s++) {
      const f = fkLeg(P, R, s === 0 ? 1 : -1, q, s * 6)
      const o = p.feet[s]!, st = this.stepper.feet[s]!
      o.x = st.x = f.sole[0]
      o.y = st.y = Math.max(0, f.sole[1])
      o.z = st.z = f.sole[2]
      o.yaw = st.yaw = Math.atan2(f.soleR[2], f.soleR[8])
    }
  }

  private beginRise() {
    this.riseOn = true
    const p = this.cur
    this.riseY0 = p.y
    this.riseP0 = p.pitch
    this.riseR0 = p.roll
    for (let i = 0; i < 12; i++) this.riseQ[i] = p.q[i]!
    for (let s = 0; s < 2; s++) {
      const f = p.feet[s]!
      f.y = 0
      f.yaw = p.yaw
      const st = this.stepper.feet[s]!
      st.x = f.x; st.z = f.z; st.y = 0; st.yaw = p.yaw
      this.stepper.planted[s] = true
    }
  }

  private endFall() {
    const p = this.cur
    this.stepper.adopt(p.x, p.z, p.yaw, p.feet)
    this.mode = 'stand'
    p.k = 0
    this.riseOn = false
    this.pitchKick.x = this.pitchKick.v = 0
    this.rollKick.x = this.rollKick.v = 0
    // Up again: dust itself off, then wave as if nothing happened.
    this.dustT = MAKEY_GAIT.dustT
    this.afterFall = true
  }

  // ── Head, eyes and arms ─────────────────────────────────────────────────

  private lookStep(dt: number) {
    let ty = 0, tp = 0, tilt = 0
    let glow = 0.7
    const p = this.cur
    const fallen = this.mode === 'fall'
    if (this.asleep) {
      tp = -MAKEY_GAIT.neckPitchLimit
      glow = 0.12
    }
    else if (fallen) {
      const tag = this.script.tag
      // A beat on the ground: eyes dim, then a shake of the head before it gets up.
      if (tag === 'ground' || tag === 'settle') {
        glow = 0.2
        ty = tag === 'ground' ? 0.5 * Math.sin(2 * Math.PI * 2.2 * this.script.t) * this.script.u : 0
      }
      else glow = 0.55
      tp = this.fallFront ? 0.3 : -0.2
    }
    else if (this.look) {
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw)
      const dx = this.look.x - p.x, dz = this.look.z - p.z, dy = this.look.y - (p.y + 0.18)
      const fwd = dx * fx + dz * fz
      const left = dx * fz - dz * fx
      ty = Math.atan2(left, fwd)
      tp = Math.atan2(dy, Math.hypot(fwd, left))
      glow = 0.85
      // A greeting: the target has held still near it.
      this.lookHeld += dt
      const near = Math.hypot(dx, dz) < MAKEY_GAIT.waveNear
      if (this.autoWave && !this.posterMode && near && this.lookHeld > MAKEY_GAIT.waveHold && this.waveCool <= 0 && !this.busy && Math.abs(ty) < 1.2) {
        this.wave(ty >= 0 ? 1 : -1)
      }
    }
    else if (!this.posterMode) {
      this.glanceT -= dt
      if (this.glanceT <= 0) {
        this.glanceY = this.rand.range(-0.9, 0.9) * (this.mode === 'walk' ? 0.5 : 1)
        this.glanceP = this.rand.range(-0.2, 0.2)
        this.glanceT = this.rand.range(1.2, 3.5)
      }
      ty = this.glanceY + this.stepper.w * 0.3
      tp = this.glanceP
    }
    if (this.waveT > 0) {
      tilt = (this.waveBoth ? 0 : -this.waveSide) * 0.22
      glow = 1
    }
    if (this.dustT > 0) tp = -0.35
    ty = clamp(ty, -MAKEY_GAIT.neckYawLimit, MAKEY_GAIT.neckYawLimit)
    tp = clamp(tp, -MAKEY_GAIT.neckPitchLimit, MAKEY_GAIT.neckPitchLimit)
    if (this.posterMode) {
      this.neckY.x = ty; this.neckP.x = tp; this.tilt.x = tilt; this.glow.x = glow
      this.neckY.v = this.neckP.v = this.tilt.v = this.glow.v = 0
      return
    }
    this.neckY.step(ty, 9, 0.75, dt)
    this.neckP.step(tp, 9, 0.75, dt)
    this.tilt.step(tilt, 7, 0.6, dt)
    this.glow.step(glow, 6, 1, dt)
    this.neckY.limit(MAKEY_GAIT.neckYawLimit)
    this.neckP.limit(MAKEY_GAIT.neckPitchLimit)
  }

  private armStep(dt: number) {
    const st = this.stepper
    const fallen = this.mode === 'fall'
    if (this.waveT > 0 && !this.posterMode) this.waveT = Math.max(0, this.waveT - dt)
    if (this.dustT > 0) {
      this.dustT = Math.max(0, this.dustT - dt)
      if (this.dustT === 0 && this.afterFall) {
        this.afterFall = false
        this.waveCool = 0
        this.wave(1)
      }
    }
    const tgt = ARM_TGT
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1
      const o = s * 5
      if (fallen) {
        const base = s === 0 ? ARM_L : ARM_R
        for (let j = 0; j < 5; j++) tgt[o + j] = this.script.pose.q[base + j]!
        if (this.riseOn) {
          // Standing up: arms come down to the sides for balance.
          const a = side > 0 ? ARM_REST : mirror(ARM_REST)
          for (let j = 0; j < 5; j++) tgt[o + j] = a[j]!
        }
        continue
      }
      // Walking: the arm swings against the leg on its side.
      const swing = MAKEY_GAIT.armSwing * st.g * Math.sin(2 * Math.PI * st.phi) * side
      const rest = side > 0 ? ARM_REST : mirror(ARM_REST)
      tgt[o] = rest[0] + swing
      tgt[o + 1] = rest[1] + side * 0.05 * st.g
      tgt[o + 2] = rest[2] - 0.15 * st.g
      tgt[o + 3] = rest[3]
      tgt[o + 4] = rest[4]
      if (this.asleep) {
        tgt[o] = 0.1
        tgt[o + 1] = side * 0.04
        tgt[o + 2] = 0
      }
      if (this.mode === 'hop') {
        // Arms fly up with the jump.
        tgt[o] = -0.4
        tgt[o + 1] = side * 1.2
        tgt[o + 2] = -0.5
      }
      if (this.dustT > 0) {
        // Dusting off: hands brush down the front of the body, alternating.
        const ph = 2 * Math.PI * 2.2 * (MAKEY_GAIT.dustT - this.dustT) + (s === 0 ? 0 : Math.PI)
        tgt[o] = -0.55 + 0.3 * Math.sin(ph)
        tgt[o + 1] = side * -0.15
        tgt[o + 2] = -1.5 + 0.25 * Math.cos(ph)
        tgt[o + 3] = 0
        tgt[o + 4] = side * 0.3 * Math.sin(ph)
      }
      const waving = this.waveT > 0 && (this.waveBoth || this.waveSide === side)
      if (waving) {
        // Up in 0.25 s, wave from the elbow with a wrist wag, down over the last 0.3 s.
        const age = MAKEY_GAIT.waveT - this.waveT
        const k = Math.min(smooth(Math.min(1, age / 0.25)), smooth(Math.min(1, this.waveT / 0.3)))
        const w = side > 0 ? ARM_WAVE : mirror(ARM_WAVE)
        const wag = Math.sin(2 * Math.PI * 2.6 * age) * smooth(Math.min(1, age / 0.35))
        for (let j = 0; j < 5; j++) tgt[o + j] = tgt[o + j]! + (w[j]! - tgt[o + j]!) * k
        tgt[o + 3] = tgt[o + 3]! + side * 0.35 * wag * k
        tgt[o + 4] = side * 0.4 * wag * k
      }
    }
    for (let j = 0; j < 10; j++) {
      const sp = this.arm[j]!
      if (this.posterMode) {
        sp.x = tgt[j]!
        sp.v = 0
      }
      else sp.step(tgt[j]!, fallen ? 18 : 16, 0.8, dt)
      this.cur.q[12 + j] = sp.x
    }
  }

  // ── Pose ────────────────────────────────────────────────────────────────

  private compose() {
    const p = this.cur
    const st = this.stepper
    const c = st.phi - MAKEY_STEP.ds / 4
    const sway = -MAKEY_GAIT.sway * Math.sin(2 * Math.PI * c) * st.g
    const bobN = -Math.cos(4 * Math.PI * c) * st.g
    const breath = this.posterMode ? 0 : (this.asleep ? 0.003 : 0.001) * Math.sin(2 * Math.PI * this.t / (this.asleep ? 3.6 : 2.8)) * (1 - st.g)
    const lat = sway + this.shift.x
    p.yaw = st.yaw
    p.x = st.bx + Math.cos(st.yaw) * lat
    p.z = st.bz - Math.sin(st.yaw) * lat
    p.y = (this.mode === 'hop' ? this.hopY : MAKEY_GAIT.standH) + MAKEY_GAIT.bob * bobN + (this.mode === 'stand' ? breath : 0) - (this.asleep ? 0.006 : 0)
    p.roll = clamp(-lat * MAKEY_GAIT.rollMax / MAKEY_GAIT.sway + this.rollKick.x, -0.25, 0.25)
    const bow = this.dustT > 0 ? 0.12 * Math.sin(Math.PI * this.dustT / MAKEY_GAIT.dustT) : 0
    p.pitch = clamp(MAKEY_GAIT.pitchPerSpeed * st.v + this.pitchKick.x + bow, -0.3, 0.3)
    for (let i = 0; i < 2; i++) Object.assign(p.feet[i]!, st.feet[i])
    p.k = 0
    p.neckYaw = this.neckY.x
    p.neckPitch = this.neckP.x
    p.headTilt = this.tilt.x
    p.glow = clamp(this.glow.x, 0, 1.2)
  }

  snapshot() {
    return JSON.stringify({
      cur: this.cur, st: this.stepper.snapshot(), mode: this.mode, t: this.t,
      springs: [this.shift, this.pitchKick, this.rollKick, this.neckY, this.neckP, this.tilt, this.glow, ...this.arm].map(k => [k.x, k.v]),
      w: [this.waveT, this.waveSide, this.waveBoth, this.waveCool, this.dustT, this.lookHeld], hop: [this.hopT, this.hopY, this.hopStage],
      sc: [this.script.i, this.script.t], ev: [this.touchdowns, this.thuds, this.hops, this.waves],
    })
  }
}

const IDENT: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
const ARMPTS = { elbow: vec3(), wrist: vec3(), hand: vec3() }
const ARM_TGT = new Array(10).fill(0)

// ── Choreography (SCRIPTED) ──────────────────────────────────────────────

/** Leg joints [hipYaw, hipRoll, hipPitch, knee, anklePitch, ankleRoll] for both legs, mirrored. */
function legsQ(hipPitch: number, knee: number, ankle: number, splay = 0): number[] {
  return [0, splay, hipPitch, knee, ankle, -splay, 0, -splay, hipPitch, knee, ankle, splay]
}
function armsQ(a: Arm5): number[] {
  return [...a, ...mirror(a)]
}
const pose = (pitch: number, legs: number[], arms: number[], yaw: number, lift = 0): ScriptPose => ({ pitch, roll: 0, yaw, q: [...legs, ...arms], lift })
/** Ankle angle that keeps the sole flat for a body pitch, hip and knee. */
const flat = (pitch: number, hip: number, knee: number) => -(pitch + hip + knee)

/** Pushed from the front: over onto its back, sit up, push off its hands, stand. */
export function backKeys(twist: number): Key[] {
  const sit = { p: -0.3, h: -1.25, k: 0.2 }
  const tuck = { p: -0.25, h: -2.05, k: 2.25 }
  const squat = { p: 0.42, h: -1.85, k: 2.3 }
  return [
    { dur: 0.5, ease: 'in', tag: 'topple', pose: pose(-1.5, legsQ(-0.15, 0.15, 0.1), armsQ([-1.3, 0.5, -0.3, 0, 0]), twist) },
    { dur: 0.12, ease: 'out', tag: 'impact', pose: pose(-1.36, legsQ(-0.35, 0.3, 0.1), armsQ([-1.6, 0.7, -0.5, 0, 0]), twist) },
    { dur: 0.22, ease: 'inout', tag: 'settle', pose: pose(-1.52, legsQ(-0.2, 0.2, 0.1), armsQ([-0.6, 0.9, -0.2, 0, 0]), twist) },
    { dur: 0.65, ease: 'inout', tag: 'ground', pose: pose(-1.52, legsQ(-0.25, 0.3, 0.15), armsQ([-0.4, 0.95, -0.3, 0, 0]), twist) },
    { dur: 0.6, ease: 'inout', tag: 'situp', pose: pose(sit.p, legsQ(sit.h, sit.k, 0.4), armsQ([0.75, 0.25, 0, 0, 0]), twist) },
    { dur: 0.45, ease: 'inout', tag: 'tuck', pose: pose(tuck.p, legsQ(tuck.h, tuck.k, flat(tuck.p, tuck.h, tuck.k), 0.1), armsQ([0.95, 0.2, -0.1, 0, 0]), twist) },
    { dur: 0.55, ease: 'inout', tag: 'push', pose: pose(squat.p, legsQ(squat.h, squat.k, flat(squat.p, squat.h, squat.k), 0.1), armsQ([-0.8, 0.25, -0.4, 0, 0]), twist) },
    { dur: 0.65, ease: 'inout', tag: 'rise', pose: pose(squat.p, legsQ(squat.h, squat.k, flat(squat.p, squat.h, squat.k), 0.1), armsQ([-0.8, 0.25, -0.4, 0, 0]), twist) },
  ]
}

/** Pushed from behind: onto its hands and front, up onto its knees, into a squat, stand. */
export function frontKeys(twist: number): Key[] {
  const kneel = { p: 0.65, h: -0.65, k: 1.6 }
  const squat = { p: 0.42, h: -1.85, k: 2.3 }
  return [
    { dur: 0.45, ease: 'in', tag: 'topple', pose: pose(1.35, legsQ(0.05, 0.15, -0.1), armsQ([-1.5, 0.3, -0.1, 0, 0]), twist) },
    { dur: 0.12, ease: 'out', tag: 'impact', pose: pose(1.22, legsQ(0.05, 0.2, -0.1), armsQ([-1.35, 0.4, -0.7, 0, 0]), twist) },
    { dur: 0.25, ease: 'inout', tag: 'settle', pose: pose(1.35, legsQ(0, 0.25, -0.2), armsQ([-1.1, 0.5, -1.0, 0, 0]), twist) },
    { dur: 0.6, ease: 'inout', tag: 'ground', pose: pose(1.35, legsQ(0, 0.3, -0.25), armsQ([-1.1, 0.55, -1.05, 0, 0]), twist) },
    { dur: 0.6, ease: 'inout', tag: 'kneel', pose: pose(kneel.p, legsQ(kneel.h, kneel.k, 0.2), armsQ([-0.62, 0.2, -0.05, 0, 0]), twist) },
    { dur: 0.55, ease: 'inout', tag: 'push', pose: pose(squat.p, legsQ(squat.h, squat.k, flat(squat.p, squat.h, squat.k), 0.1), armsQ([-0.8, 0.25, -0.4, 0, 0]), twist) },
    { dur: 0.65, ease: 'inout', tag: 'rise', pose: pose(squat.p, legsQ(squat.h, squat.k, flat(squat.p, squat.h, squat.k), 0.1), armsQ([-0.8, 0.25, -0.4, 0, 0]), twist) },
  ]
}

export const FALL_TOTAL = Math.max(...[backKeys(0), frontKeys(0)].map(k => k.reduce((t, x) => t + x.dur, 0)))
export { ARM }
