import { rng, type Rng } from '../../core/rng'
import type { Collider, ContactOther, Normal } from '../contact'
import { GRAB, grabForce, type Force3 } from '../grab'
import { DOG, fkLocal, legFore, legSide, newLegQ, solveLeg, type LegFK } from './ik'
import { Spring, approach, bodyRotation, clamp, mat3, smooth, vec3, type Mat3 } from './kin'
import { Script, Support, newScriptPose, type Key, type ScriptPose } from './script'
import { Stepper, moving, type Command, type StepperSpec } from './stepper'

/**
 * The robot dog's behaviour: a PROCEDURAL, KINEMATIC quadruped. Nothing is
 * physically simulated. Pure TypeScript (the tests run it headless).
 *
 * - Walking is a TROT (stepper.ts): diagonal pairs swing together, footholds
 *   planned in world space, planted feet never move, the governor slows the
 *   body rather than let a foot slide. Legs are solved by ik.ts.
 * - The body rides on the feet: a small bob kicked at every touchdown (a
 *   critically-damped sink, not a sine), a lean into the speed, a roll into
 *   turns and a pitch from acceleration. Diagonal support has no net roll or
 *   pitch, which is why a trot looks level.
 * - Postures move the body over planted feet: SIT (the hind legs fold, nose
 *   up), BOW (front down, rear up, with a wiggle), LIE (sleep), STAND.
 * - The HOP (tap) is SCRIPTED: crouch, a constant-acceleration push to the
 *   take-off speed, a ballistic arc (g = 9.81) with the legs tucking, a
 *   critically-damped landing and a happy wiggle.
 * - The FALL and the SELF-RIGHTING ROLL are SCRIPTED (script.ts): it tips
 *   over its downhill feet onto its side, rebounds, settles, lies there a
 *   beat, tucks its legs, swings them over and rolls onto its belly, then
 *   stands up with its feet planted. The body position always comes from
 *   resting on its lowest points, so it pivots over real edges and nothing
 *   sinks into the floor.
 */

const deg = Math.PI / 180

export const DOG_GAIT = {
  standH: 0.18,
  /** Postures: front and rear hip heights, and the body's fore/aft shift over the feet. */
  sit: { hF: 0.175, hR: 0.07, shift: -0.035 },
  bow: { hF: 0.085, hR: 0.2, shift: 0.025 },
  lie: { hF: 0.072, hR: 0.07, shift: 0 },
  postureT: 0.45,
  bowHold: 1.8,
  /** Touchdown sink (m/s kicked into the height spring) and its stiffness. */
  sink: 0.09,
  bob: 0.003,
  pitchPerSpeed: 4 * deg / 0.3,
  rollPerTurn: 2.5 * deg,
  pitchPerAccel: 1.2 * deg,
  headYawLimit: 0.75,
  headPitchLimit: 0.5,
  headOmega: 10,
}

export const DOG_STEP: StepperSpec = {
  feet: [0, 1, 2, 3].map(i => ({ x: legSide(i) * (DOG.hipX + DOG.d), z: legFore(i) * DOG.hipZ })),
  groups: [[0, 3], [1, 2]],
  stepTime: 0.2,
  staggerStepTime: 0.16,
  ds: 0.12,
  swingH: 0.034,
  maxSpeed: 0.3,
  maxBack: 0.14,
  maxYawRate: 1.6,
  maxStrafe: 0.12,
  accel: 0.9,
  yawAccel: 5,
  govAccel: 3,
  govYawAccel: 14,
  staggerAccel: 4,
  reach: 0.07,
  latReach: 0.035,
  yawReach: 0.35,
  maxStep: 0.14,
  maxStepYaw: 0.4,
}

export const HOP = {
  crouchT: 0.16,
  crouchH: 0.13,
  takeoffH: 0.195,
  v0: 0.75,
  g: 9.81,
  tuck: 0.035,
  landT: 0.45,
  landOmega: 13,
  dist: 0.035,
  wiggleT: 0.7,
}
const HOP_PUSH_T = 2 * (HOP.takeoffH - HOP.crouchH) / HOP.v0
const HOP_ACC = HOP.v0 * HOP.v0 / (2 * (HOP.takeoffH - HOP.crouchH))
const HOP_FLIGHT_T = 2 * HOP.v0 / HOP.g
export const HOP_TOTAL = HOP.crouchT + HOP_PUSH_T + HOP_FLIGHT_T + HOP.landT

/**
 * Contact: two body circles fore and aft, one for the head, one per foot.
 * A planted foot is `fixed`. The response: the overlap moves the body (and a
 * swing foot's landing), never a planted foot; a real impact staggers it,
 * a hard one knocks it over.
 */
export const DOG_SHAPE = {
  mass: 2.6,
  bodyR: 0.075,
  bodyAt: [0.085, -0.085],
  headR: 0.05,
  headAt: 0.21,
  footR: 0.018,
  /** Lying on its side: the legs as two circles this far out from the body axis. */
  legsR: 0.05,
  legsOut: 0.12,
  replant: 0.006,
  stumbleMin: 0.04,
  /**
   * Static obstacles (walls, posts, props): a press or a bump makes it step
   * AWAY once, then it ignores further static pushes for `staticCool` s --
   * otherwise a director that keeps walking it into a wall restarts the
   * stumble forever. For `staticMemory` s after touching one, the part of a
   * command that points into the obstacle is dropped, so it slides along a
   * wall instead of pressing into it.
   */
  staticCool: 1.5,
  staticMemory: 0.35,
  staticStumble: 0.12,
  /** Impact share (m/s) that knocks it over. */
  fallImpact: 0.5,
  /** Grab: a pull above this (N) walks it along; above `fallForce` for `fallHold` s it goes over. */
  // Grab thresholds are fractions of the hand's strength (GRAB.maxForce), so
  // they keep their meaning if the shared grab spring is retuned: a pull
  // well short of a full yank walks it along, a full yank held a moment
  // knocks it over.
  dragWalk: 0.16 * GRAB.maxForce,
  fallForce: 0.75 * GRAB.maxForce,
  fallHold: 0.15,
}

/** Joint order: leg i -> q[3i] abduction, q[3i+1] hip, q[3i+2] knee. */
export interface DogPose {
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  roll: number
  /** Ground contact points of the feet (world); the pad centre is DOG.footR above. */
  feet: { x: number, y: number, z: number }[]
  /** Scripted joint angles, used with weight k (0 = legs solved from feet, 1 = scripted). */
  q: number[]
  k: number
  headYaw: number
  headPitch: number
}

export function newPose(): DogPose {
  return {
    x: 0, y: DOG_GAIT.standH, z: 0, yaw: 0, pitch: 0, roll: 0,
    feet: [0, 1, 2, 3].map(() => ({ x: 0, y: 0, z: 0 })), q: new Array(12).fill(0), k: 0, headYaw: 0, headPitch: 0,
  }
}

export function copyPose(a: DogPose, b: DogPose) {
  b.x = a.x; b.y = a.y; b.z = a.z; b.yaw = a.yaw; b.pitch = a.pitch; b.roll = a.roll
  for (let i = 0; i < 4; i++) {
    b.feet[i]!.x = a.feet[i]!.x; b.feet[i]!.y = a.feet[i]!.y; b.feet[i]!.z = a.feet[i]!.z
  }
  for (let i = 0; i < 12; i++) b.q[i] = a.q[i]!
  b.k = a.k; b.headYaw = a.headYaw; b.headPitch = a.headPitch
}

export function lerpPose(a: DogPose, b: DogPose, t: number, o: DogPose) {
  const l = (p: number, q: number) => p + (q - p) * t
  o.x = l(a.x, b.x); o.y = l(a.y, b.y); o.z = l(a.z, b.z)
  o.yaw = l(a.yaw, b.yaw); o.pitch = l(a.pitch, b.pitch); o.roll = l(a.roll, b.roll)
  for (let i = 0; i < 4; i++) {
    const fa = a.feet[i]!, fb = b.feet[i]!, fo = o.feet[i]!
    fo.x = l(fa.x, fb.x); fo.y = l(fa.y, fb.y); fo.z = l(fa.z, fb.z)
  }
  for (let i = 0; i < 12; i++) o.q[i] = l(a.q[i]!, b.q[i]!)
  o.k = l(a.k, b.k); o.headYaw = l(a.headYaw, b.headYaw); o.headPitch = l(a.headPitch, b.headPitch)
  return o
}

const PR = mat3(), PB = vec3(), PF = vec3(), LQ = newLegQ()

/**
 * The 12 joint angles for a pose: IK from the feet blended with the scripted
 * angles by pose.k. The renderer and the tests both call this.
 */
export function poseJoints(p: DogPose, out: number[]) {
  const R = bodyRotation(p.yaw, p.pitch, p.roll, PR)
  PB[0] = p.x; PB[1] = p.y; PB[2] = p.z
  for (let i = 0; i < 4; i++) {
    let a = 0, h = 0, kn = 0
    if (p.k < 1) {
      const f = p.feet[i]!
      PF[0] = f.x; PF[1] = f.y + DOG.footR; PF[2] = f.z
      const s = solveLeg(PB, R, i, PF, LQ)
      a = s.abd; h = s.hip; kn = s.knee
    }
    const k = p.k
    out[3 * i] = a + (p.q[3 * i]! - a) * k
    out[3 * i + 1] = h + (p.q[3 * i + 1]! - h) * k
    out[3 * i + 2] = kn + (p.q[3 * i + 2]! - kn) * k
  }
  return out
}

export type Posture = 'stand' | 'sit' | 'bow' | 'lie'
export type DogMode = 'stand' | 'walk' | 'hop' | 'fall'

/** Support points for the scripted falls: shell corners, head, hip motors, knees, feet. */
const SHELL: [number, number, number, number][] = []
for (const x of [-0.055, 0.055]) {
  for (const y of [-0.035, 0.045]) for (const z of [-0.175, 0.175]) SHELL.push([x, y, z, 0.012])
}
SHELL.push([0, 0.035, 0.225, 0.03], [0, -0.02, 0.215, 0.02])
for (let i = 0; i < 4; i++) SHELL.push([legSide(i) * (DOG.hipX + DOG.d + 0.012), 0, legFore(i) * DOG.hipZ, 0.032])
const NSUP = SHELL.length + 8

export class DogGait {
  readonly cur = newPose()
  readonly prev = newPose()
  readonly stepper = new Stepper(DOG_STEP)
  mode: DogMode = 'stand'
  posture: Posture = 'stand'
  asleep = false
  /** Event counters for sounds (the owner diffs them): pair touchdowns, impacts on the ground, hops. */
  touchdowns = 0
  thuds = 0
  hops = 0
  /** Body velocity over the last step, world XZ. */
  vx = 0
  vz = 0
  readonly colliders: Collider[] = [0, 1, 2, 3, 4, 5, 6].map(k => ({
    x: 0, z: 0, r: k < 2 ? DOG_SHAPE.bodyR : k === 2 ? DOG_SHAPE.headR : DOG_SHAPE.footR, vx: 0, vz: 0, fixed: k >= 3,
  }))
  /** Grab force last step (world, N) -- diagnostic. */
  readonly force: Force3 = { x: 0, y: 0, z: 0 }

  private t = 0
  private readonly rand: Rng
  private readonly cmd: Command = { speed: 0, yawRate: 0, strafe: 0 }
  // Posture (front / rear hip heights and shift), eased.
  private hF = DOG_GAIT.standH
  private hR = DOG_GAIT.standH
  private shift = 0
  private pFrom = { hF: DOG_GAIT.standH, hR: DOG_GAIT.standH, shift: 0 }
  private pT = 1
  private bowT = 0
  private wiggleT = 0
  // Springs: height sink, pitch and roll kicks, head look, body look.
  private sink = new Spring()
  private pitchKick = new Spring()
  private rollKick = new Spring()
  private headY = new Spring()
  private headP = new Spring()
  private bodyY = new Spring()
  private bodyP = new Spring()
  private look: { x: number, y: number, z: number } | null = null
  private glanceT = 1
  private glanceY = 0
  private glanceP = 0
  private shiftT = 2
  private shiftX = 0
  private shiftS = new Spring()
  private vPrev = 0
  // Hop.
  private hopQueued = false
  private hopT = 0
  private hopStage = 0
  private hopY = DOG_GAIT.standH
  private hop0 = [0, 1, 2, 3].map(() => ({ x: 0, z: 0 }))
  private hopD = { x: 0, z: 0 }
  // Stagger / contact.
  private recovering = false
  private pushed = 0
  /** Last static contact: its normal (away from the obstacle), time since, and the stumble cooldown. */
  private readonly staticN = { x: 0, z: 0 }
  private staticT = Infinity
  private staticCool = 0
  // Fall.
  readonly script = new Script(12)
  private readonly support = new Support(NSUP)
  private readonly supPts = new Float64Array(NSUP * 3)
  private readonly supRad = new Float64Array(NSUP)
  private fallYaw = 0
  private riseFeet = [0, 1, 2, 3].map(() => ({ x: 0, z: 0 }))
  private riseY0 = 0
  private riseP0 = 0
  private riseR0 = 0
  private riseOn = false
  // Grab.
  private grabbed = false
  private readonly grabLocal = vec3()
  private readonly grabPrev = vec3()
  private grabTarget = vec3()
  private hardPull = 0

  constructor(seed: number, readonly posterMode = false) {
    this.rand = rng(seed)
    this.placeAt(0, 0, 0)
  }

  get busy() {
    return this.mode === 'hop' || this.mode === 'fall' || this.hopQueued || this.stepper.stagger > 0 || this.recovering
  }

  get fallen() {
    return this.mode === 'fall'
  }

  get position() {
    return this.mode === 'fall' ? { x: this.cur.x, z: this.cur.z } : { x: this.stepper.bx, z: this.stepper.bz }
  }

  get heading() {
    return this.mode === 'fall' ? this.cur.yaw : this.stepper.yaw
  }

  placeAt(x: number, z: number, heading: number) {
    this.stepper.placeAt(x, z, heading)
    this.mode = 'stand'
    this.hopQueued = false
    this.recovering = false
    this.pushed = 0
    this.script.i = this.script.keys.length
    this.compose()
    copyPose(this.cur, this.prev)
    this.vx = this.vz = 0
    this.updateColliders()
  }

  lookAt(p: { x: number, y: number, z: number } | null) {
    this.look = p ? { x: p.x, y: p.y, z: p.z } : null
  }

  /** 'tap' = happy hop; 'shove' = a stumble backward; 'tumble' = knocked over (scripted fall and self-righting). */
  react(kind: 'tap' | 'shove' | 'tumble') {
    if (this.posterMode || this.mode === 'fall') return
    if (kind === 'tumble') {
      const a = this.rand.range(0, Math.PI * 2)
      this.startFall(Math.sin(a), Math.cos(a))
      return
    }
    if (this.busy) return
    if (kind === 'tap') {
      this.hopQueued = true
      this.setPosture('stand')
      return
    }
    this.pitchKick.v -= 1.2
    this.stepper.stumble(-0.28, 0, 3)
    this.setPosture('stand')
  }

  setPosture(p: Posture) {
    if (this.posterMode && p !== this.posture) {
      this.posture = p
      const t = DOG_GAIT[p === 'stand' ? 'lie' : p] as { hF: number, hR: number, shift: number }
      if (p === 'stand') { this.hF = this.hR = DOG_GAIT.standH; this.shift = 0 }
      else { this.hF = t.hF; this.hR = t.hR; this.shift = t.shift }
      this.pT = 1
      return
    }
    if (p === this.posture) return
    this.posture = p
    this.pFrom = { hF: this.hF, hR: this.hR, shift: this.shift }
    this.pT = 0
    if (p === 'bow') {
      this.bowT = DOG_GAIT.bowHold
      this.headP.v += 2
    }
  }

  setSleep(on: boolean) {
    if (this.asleep && !on && !this.posterMode) {
      this.pitchKick.v -= 1
      this.headP.v += 4
    }
    this.asleep = on
    if (on) this.setPosture('lie')
    else if (this.posture === 'lie') this.setPosture('stand')
  }

  setPaused(paused: boolean) {
    if (paused) {
      this.hopQueued = false
      this.look = null
      this.grab(null)
    }
  }

  /** Grab at a world point on the body (null releases). */
  grab(at: { x: number, y: number, z: number } | null) {
    if (!at || this.posterMode) {
      this.grabbed = false
      this.hardPull = 0
      return
    }
    // Store the point in the body frame so it is carried with the body.
    const p = this.cur
    const R = bodyRotation(p.yaw, p.pitch, p.roll, PR)
    const dx = at.x - p.x, dy = at.y - p.y, dz = at.z - p.z
    this.grabLocal[0] = R[0] * dx + R[3] * dy + R[6] * dz
    this.grabLocal[1] = R[1] * dx + R[4] * dy + R[7] * dz
    this.grabLocal[2] = R[2] * dx + R[5] * dy + R[8] * dz
    this.grabPrev[0] = at.x; this.grabPrev[1] = at.y; this.grabPrev[2] = at.z
    this.grabTarget = [at.x, at.y, at.z]
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
    this.staticT += dt
    if (this.staticCool > 0) this.staticCool = Math.max(0, this.staticCool - dt)
    const bx0 = this.cur.x, bz0 = this.cur.z
    if (this.grabbed) this.pull(dt)

    if (this.mode === 'fall') {
      this.fallStep(dt)
    }
    else {
      const cmd = this.cmd
      if (this.posterMode) cmd.speed = cmd.yawRate = cmd.strafe = 0
      else {
        cmd.speed = cmdIn.speed
        cmd.yawRate = cmdIn.yawRate
        cmd.strafe = cmdIn.strafe ?? 0
        if (this.staticT < DOG_SHAPE.staticMemory) this.slideAlong(cmd)
      }
      // A walk command brings it to its feet first.
      if (moving(cmd) && this.posture !== 'stand' && !this.asleep) this.setPosture('stand')
      this.postureStep(dt)
      const st = this.stepper
      const ready = this.pT >= 1 && this.posture === 'stand'
      const hold = this.hopQueued || this.recovering || this.asleep || !ready || this.mode === 'hop'
      if (this.mode === 'hop') this.hopStep(dt)
      else {
        const stag = st.stagger
        st.step(dt, cmd, hold)
        if (stag > 0 && st.stagger === 0) this.recovering = true
        if (this.recovering && st.mode === 'stand') this.recovering = false
        if (st.landed >= 0) {
          st.landed = -1
          this.touchdowns++
          // Each touchdown sinks the body a little (it is caught by the legs' springs).
          this.sink.v -= DOG_GAIT.sink * (0.4 + 0.6 * Math.min(1, Math.abs(st.v) / 0.2))
          this.pushed = 0
        }
        this.mode = st.mode
        if (this.hopQueued && st.mode === 'stand' && ready) this.startHop()
      }
      this.springsStep(dt)
    }
    this.lookStep(dt)
    if (this.mode !== 'fall') this.compose()
    this.vx = (this.cur.x - bx0) / dt
    this.vz = (this.cur.z - bz0) / dt
    this.updateColliders()
  }

  private postureStep(dt: number) {
    if (this.pT < 1) this.pT = Math.min(1, this.pT + dt / DOG_GAIT.postureT)
    const target = this.posture === 'stand' ? { hF: DOG_GAIT.standH, hR: DOG_GAIT.standH, shift: 0 } : DOG_GAIT[this.posture]
    const e = smooth(this.pT)
    this.hF = this.pFrom.hF + (target.hF - this.pFrom.hF) * e
    this.hR = this.pFrom.hR + (target.hR - this.pFrom.hR) * e
    this.shift = this.pFrom.shift + (target.shift - this.pFrom.shift) * e
    if (this.posture === 'bow' && this.pT >= 1) {
      this.bowT -= dt
      if (this.bowT <= 0) this.setPosture('stand')
    }
  }

  private springsStep(dt: number) {
    const st = this.stepper
    this.sink.step(0, 16, 0.75, dt)
    const acc = (st.v - this.vPrev) / dt
    this.vPrev = st.v
    this.pitchKick.step(-DOG_GAIT.pitchPerAccel * clamp(acc, -2, 2), 10, 0.5, dt)
    this.rollKick.step(0, 11, 0.45, dt)
    if (this.wiggleT > 0) this.wiggleT = Math.max(0, this.wiggleT - dt)
    // Idle weight shifts while standing.
    if (!this.posterMode && this.mode === 'stand') {
      this.shiftT -= dt
      if (this.shiftT <= 0) {
        const r = this.rand.next()
        this.shiftX = r < 0.4 ? 0 : this.rand.range(-0.008, 0.008)
        this.shiftT = this.rand.range(2, 5)
      }
    }
    this.shiftS.step(this.mode === 'stand' ? this.shiftX : 0, 3, 1, dt)
  }

  // ── Hop (scripted) ──────────────────────────────────────────────────────

  private startHop() {
    this.mode = 'hop'
    this.hopQueued = false
    this.hopT = 0
    this.hopStage = 0
    const st = this.stepper
    for (let i = 0; i < 4; i++) {
      this.hop0[i]!.x = st.feet[i]!.x
      this.hop0[i]!.z = st.feet[i]!.z
    }
    this.hopD.x = Math.sin(st.yaw) * HOP.dist
    this.hopD.z = Math.cos(st.yaw) * HOP.dist
    this.hops++
  }

  private hopStep(dt: number) {
    const st = this.stepper
    this.hopT += dt
    let t = this.hopT
    if (t < HOP.crouchT) {
      this.hopY = DOG_GAIT.standH + (HOP.crouchH - DOG_GAIT.standH) * smooth(t / HOP.crouchT)
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
        for (let i = 0; i < 4; i++) st.planted[i] = false
        this.headP.v += 2
      }
      const yb = HOP.v0 * t - 0.5 * HOP.g * t * t
      const k = t / HOP_FLIGHT_T
      this.hopY = HOP.takeoffH + yb
      st.bx += this.hopD.x * dt / HOP_FLIGHT_T
      st.bz += this.hopD.z * dt / HOP_FLIGHT_T
      const fy = yb + HOP.tuck * Math.sin(Math.PI * k)
      for (let i = 0; i < 4; i++) {
        const f = st.feet[i]!, f0 = this.hop0[i]!
        f.x = f0.x + this.hopD.x * k
        f.z = f0.z + this.hopD.z * k
        f.y = fy
      }
      return
    }
    t -= HOP_FLIGHT_T
    if (this.hopStage < 3) {
      this.hopStage = 3
      // Touchdown on the same stance, moved forward by HOP.dist.
      for (let i = 0; i < 4; i++) {
        const f = st.feet[i]!, f0 = this.hop0[i]!
        f.x = f0.x + this.hopD.x
        f.z = f0.z + this.hopD.z
        f.y = 0
        st.planted[i] = true
        st.stanceId[i]!++
      }
      this.touchdowns++
      this.pitchKick.v += 0.8
      this.wiggleT = HOP.wiggleT
    }
    if (t < HOP.landT) {
      // Squash: critically damped from the touchdown height and speed back to standing.
      const w = HOP.landOmega
      const x0 = HOP.takeoffH - DOG_GAIT.standH
      const v0 = -HOP.v0
      const x = (tt: number) => (x0 + (v0 + w * x0) * tt) * Math.exp(-w * tt)
      this.hopY = DOG_GAIT.standH + x(t) - x(HOP.landT) * (t / HOP.landT)
      return
    }
    this.hopY = DOG_GAIT.standH
    this.mode = 'stand'
  }

  // ── Contact and grab ────────────────────────────────────────────────────

  updateColliders() {
    const cs = this.colliders
    const p = this.cur
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw)
    const down = this.mode === 'fall'
    for (let k = 0; k < 3; k++) {
      const c = cs[k]!
      const at = k < 2 ? DOG_SHAPE.bodyAt[k]! : DOG_SHAPE.headAt
      c.x = p.x + fx * at
      c.z = p.z + fz * at
      c.vx = this.vx
      c.vz = this.vz
      c.fixed = this.mode === 'hop' && this.hopStage !== 2
      c.r = k < 2 ? DOG_SHAPE.bodyR * (down ? 1.15 : 1) : DOG_SHAPE.headR
      c.y0 = down ? 0 : p.y - (k < 2 ? 0.05 : 0.0)
      c.y1 = down ? 0.2 : p.y + (k < 2 ? 0.06 : 0.09)
    }
    const st = this.stepper
    if (down) {
      // Lying on its side, the legs stick out from its belly: two circles
      // for the bundle of legs (fore and aft), out along the body's -Y as it
      // lies, so a post or a wall pushes the whole dog, legs included.
      const R = bodyRotation(p.yaw, p.pitch, p.roll, PR)
      const lx = -R[1], lz = -R[7]
      const out = Math.hypot(lx, lz)
      for (let i = 0; i < 4; i++) {
        const c = cs[3 + i]!
        const leg = i < 2 && out > 0.3
        c.r = leg ? DOG_SHAPE.legsR : 0
        const along = leg ? DOG_SHAPE.bodyAt[i]! : 0
        c.x = p.x + lx * DOG_SHAPE.legsOut + fx * along
        c.z = p.z + lz * DOG_SHAPE.legsOut + fz * along
        c.fixed = false
        c.vx = this.vx
        c.vz = this.vz
        c.y0 = 0
        c.y1 = 0.12
      }
      return
    }
    for (let i = 0; i < 4; i++) {
      const c = cs[3 + i]!
      const f = st.feet[i]!
      c.r = DOG_SHAPE.footR
      c.x = f.x
      c.z = f.z
      c.fixed = st.planted[i]!
      c.vx = c.vz = 0
      c.y0 = f.y
      c.y1 = f.y + 0.05
    }
  }

  /** Drop the part of a walk command that points into the obstacle just touched. */
  private slideAlong(cmd: Command) {
    const yaw = this.stepper.yaw
    const s = Math.sin(yaw), c = Math.cos(yaw)
    const st = cmd.strafe ?? 0
    let vx = s * cmd.speed + c * st
    let vz = c * cmd.speed - s * st
    const into = -(vx * this.staticN.x + vz * this.staticN.z)
    if (into <= 0) return
    vx += this.staticN.x * into
    vz += this.staticN.z * into
    cmd.speed = vx * s + vz * c
    cmd.strafe = vx * c - vz * s
  }

  collide(n: Normal, depth: number, relSpeed: number, other: ContactOther, part: number) {
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
      if (part >= 3 && st.lifted) st.reaim(part - 3, n.x * depth, n.z * depth)
      else {
        st.shiftBody(n.x * depth, n.z * depth)
        if (this.mode === 'hop') {
          for (const h of this.hop0) { h.x += n.x * depth; h.z += n.z * depth }
          for (const f of st.feet) { f.x += n.x * depth; f.z += n.z * depth }
        }
        this.pushed += depth
        this.compose()
      }
    }
    if (other === 'static') {
      this.staticN.x = n.x
      this.staticN.z = n.z
      this.staticT = 0
    }
    if (relSpeed > DOG_SHAPE.fallImpact && !this.posterMode) this.startFall(n.x, n.z)
    else if (other === 'static') {
      // One step back from the obstacle, then a cooldown: pressing on does not restart it.
      if (this.staticCool <= 0 && (relSpeed > DOG_SHAPE.stumbleMin || this.pushed > DOG_SHAPE.replant)) {
        this.staticCool = DOG_SHAPE.staticCool
        this.stumble(n.x, n.z, Math.min(relSpeed, DOG_SHAPE.staticStumble))
      }
      if (this.staticCool > 0) this.pushed = 0
    }
    else if (relSpeed > DOG_SHAPE.stumbleMin || this.pushed > DOG_SHAPE.replant) this.stumble(n.x, n.z, relSpeed)
    this.updateColliders()
  }

  /** Recovery steps along a push (world direction), faster for a harder hit. */
  private stumble(nx: number, nz: number, impact: number) {
    if (this.posterMode || this.mode === 'hop') return
    const st = this.stepper
    const speed = clamp(0.1 + 0.8 * impact, 0.1, 0.4)
    if (st.stagger > 0 && speed <= Math.hypot(st.stagV, st.stagU) + 1e-9) return
    const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw)
    const along = nx * fx + nz * fz
    const left = nx * fz - nz * fx
    this.hopQueued = false
    this.pushed = 0
    this.setPosture('stand')
    this.pitchKick.v += 1.5 * clamp(impact / 0.2, 0.3, 1.5) * along
    this.rollKick.v -= 1.5 * clamp(impact / 0.2, 0.3, 1.5) * left
    st.stumble(speed * along, speed * left, impact > 0.25 ? 3 : 2)
  }

  /** The grab spring, as a force through its own behaviour: a lean, a walk along, or over it goes. */
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
    // It leans into the pull (a feet-planted body tilting toward the hand).
    this.pitchKick.v += 0.6 * fh * along * dt
    this.rollKick.v -= 0.6 * fh * left * dt
    if (fh > DOG_SHAPE.fallForce) this.hardPull += dt
    else this.hardPull = Math.max(0, this.hardPull - dt)
    if (this.hardPull > DOG_SHAPE.fallHold) {
      this.startFall(nx, nz)
      return
    }
    if (fh > DOG_SHAPE.dragWalk) {
      const speed = clamp(0.045 * fh, 0.08, 0.32)
      if (st.stagger === 0 || speed > Math.hypot(st.stagV, st.stagU) + 0.02) {
        if (this.posture !== 'stand') this.setPosture('stand')
        if (this.pT >= 1) st.stumble(speed * along, speed * left, 2)
      }
    }
  }

  // ── Fall and self-righting (scripted) ───────────────────────────────────

  /** Knocked over toward world direction (nx, nz). */
  startFall(nx: number, nz: number) {
    if (this.mode === 'fall' || this.posterMode) return
    const p = this.cur
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw)
    const left = nx * fz - nz * fx
    // A quadruped goes over sideways: onto the side the push is toward (a push
    // straight along the body still tips it, onto a seeded side). Next to a
    // wall or a post it goes over AWAY from it: the topple carries the body
    // toward the side it falls to, and the roll back up returns over that ground.
    const wall = this.staticT < 0.6 ? this.staticN.x * fz - this.staticN.z * fx : 0
    const s = Math.abs(wall) > 0.15 ? Math.sign(wall)
      : Math.abs(left) > 0.15 ? Math.sign(left) : (this.rand.next() < 0.5 ? 1 : -1)
    const from = newScriptPose(12)
    from.pitch = p.pitch
    from.roll = p.roll
    poseJoints(p, from.q)
    this.fallYaw = p.yaw
    p.k = 1
    for (let i = 0; i < 12; i++) p.q[i] = from.q[i]!
    this.script.start(fallKeys(s, this.rand.range(-0.2, 0.2)), from)
    this.support.reset()
    this.mode = 'fall'
    this.hopQueued = false
    this.recovering = false
    this.grabbed = false
    this.riseOn = false
    this.posture = 'stand'
    this.pT = 1
    this.hF = this.hR = DOG_GAIT.standH
    this.shift = 0
    this.stepper.stagger = 0
    for (let i = 0; i < 4; i++) this.stepper.planted[i] = false
    this.headP.v += 3
  }

  private fallStep(dt: number) {
    const sc = this.script
    const prevTag = sc.tag
    sc.step(dt)
    const tag = sc.tag
    if (tag !== prevTag && prevTag === 'topple') this.thuds++
    if (tag !== prevTag && prevTag === 'roll') this.thuds++
    const p = this.cur
    const sp = sc.pose
    if (tag === 'rise' || sc.done) {
      if (!this.riseOn) this.beginRise()
      const u = sc.done ? 1 : sc.u
      const e = smooth(u)
      p.y = this.riseY0 + (DOG_GAIT.standH - this.riseY0) * e
      p.pitch = this.riseP0 * (1 - e)
      p.roll = this.riseR0 * (1 - e)
      p.k = 1 - smooth(Math.min(1, u / 0.3))
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
    // The feet ride with the legs (for contact and the shadow).
    this.feetFromJoints(R, sp.q)
  }

  private supportPoints(q: number[]) {
    let n = 0
    const P = this.supPts, Rd = this.supRad
    for (const [x, y, z, r] of SHELL) {
      P[n * 3] = x; P[n * 3 + 1] = y; P[n * 3 + 2] = z; Rd[n] = r
      n++
    }
    for (let i = 0; i < 4; i++) {
      fkLocal(i, q[3 * i]!, q[3 * i + 1]!, q[3 * i + 2]!, FK)
      P[n * 3] = FK.knee[0]; P[n * 3 + 1] = FK.knee[1]; P[n * 3 + 2] = FK.knee[2]; Rd[n] = 0.02
      n++
      P[n * 3] = FK.foot[0]; P[n * 3 + 1] = FK.foot[1]; P[n * 3 + 2] = FK.foot[2]; Rd[n] = DOG.footR
      n++
    }
    return n
  }

  private feetFromJoints(R: Mat3, q: number[]) {
    const p = this.cur
    for (let i = 0; i < 4; i++) {
      fkLocal(i, q[3 * i]!, q[3 * i + 1]!, q[3 * i + 2]!, FK)
      const f = FK.foot
      const st = this.stepper.feet[i]!
      st.x = p.x + R[0] * f[0] + R[1] * f[1] + R[2] * f[2]
      st.y = Math.max(0, p.y + R[3] * f[0] + R[4] * f[1] + R[5] * f[2] - DOG.footR)
      st.z = p.z + R[6] * f[0] + R[7] * f[1] + R[8] * f[2]
      p.feet[i]!.x = st.x; p.feet[i]!.y = st.y; p.feet[i]!.z = st.z
    }
  }

  /** The legs are folded under it: plant the feet where they are and stand up over them. */
  private beginRise() {
    this.riseOn = true
    const p = this.cur
    this.riseY0 = p.y
    this.riseP0 = p.pitch
    this.riseR0 = p.roll
    for (let i = 0; i < 4; i++) {
      const f = p.feet[i]!
      f.y = 0
      this.riseFeet[i]!.x = f.x
      this.riseFeet[i]!.z = f.z
      this.stepper.feet[i]!.y = 0
      this.stepper.planted[i] = true
    }
  }

  private endFall() {
    const p = this.cur
    this.stepper.adopt(p.x, p.z, p.yaw, this.riseFeet)
    this.mode = 'stand'
    p.k = 0
    this.riseOn = false
    this.sink.x = this.sink.v = 0
    this.pitchKick.x = this.pitchKick.v = 0
    this.rollKick.x = this.rollKick.v = 0
    // A shake to finish: it is up.
    this.wiggleT = HOP.wiggleT
  }

  // ── Look ────────────────────────────────────────────────────────────────

  private lookStep(dt: number) {
    let ty = 0, tp = 0
    const p = this.cur
    if (this.asleep) tp = -DOG_GAIT.headPitchLimit
    else if (this.mode === 'fall') {
      // On its side the head stays roughly level with the body; it lifts during the beat on the ground.
      tp = this.script.tag === 'ground' ? 0.35 : 0
    }
    else if (this.look) {
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw)
      const ex = p.x + fx * 0.21, ez = p.z + fz * 0.21
      const dx = this.look.x - ex, dz = this.look.z - ez, dy = this.look.y - (p.y + 0.04)
      const fwd = dx * fx + dz * fz
      const left = dx * fz - dz * fx
      ty = Math.atan2(left, fwd)
      tp = Math.atan2(dy, Math.hypot(fwd, left))
    }
    else if (!this.posterMode) {
      this.glanceT -= dt
      if (this.glanceT <= 0) {
        const sniff = this.mode === 'stand' && this.rand.next() < 0.25
        this.glanceY = this.rand.range(-0.7, 0.7) * (this.mode === 'walk' ? 0.4 : 1)
        this.glanceP = sniff ? -DOG_GAIT.headPitchLimit : this.rand.range(-0.2, 0.25)
        this.glanceT = this.rand.range(1.2, 3.5)
      }
      ty = this.glanceY + this.stepper.w * 0.2
      tp = this.glanceP
    }
    if (this.posture === 'bow') tp += 0.35
    if (this.posture === 'sit') tp -= 0.15
    // The body helps: standing, it twists and tips toward what the head is following.
    const still = this.mode === 'stand'
    const by = still ? clamp(ty * 0.3, -0.16, 0.16) : 0
    const bp = still ? clamp(-tp * 0.25, -0.08, 0.08) : 0
    ty = clamp(ty - by, -DOG_GAIT.headYawLimit, DOG_GAIT.headYawLimit)
    tp = clamp(tp - (still ? -bp : 0), -DOG_GAIT.headPitchLimit, DOG_GAIT.headPitchLimit)
    if (this.posterMode) {
      this.headY.x = ty; this.headP.x = tp; this.bodyY.x = by; this.bodyP.x = bp
      this.headY.v = this.headP.v = this.bodyY.v = this.bodyP.v = 0
      return
    }
    this.headY.step(ty, DOG_GAIT.headOmega, 0.8, dt)
    this.headP.step(tp, DOG_GAIT.headOmega, 0.8, dt)
    this.headY.limit(DOG_GAIT.headYawLimit)
    this.headP.limit(DOG_GAIT.headPitchLimit)
    this.bodyY.step(by, 4, 1, dt)
    this.bodyP.step(bp, 4, 1, dt)
  }

  // ── Pose ────────────────────────────────────────────────────────────────

  private compose() {
    const p = this.cur
    const st = this.stepper
    const bobN = -Math.cos(2 * Math.PI * 2 * st.phi) * st.g
    const breath = this.posterMode ? 0 : (this.asleep ? 0.004 : 0.0012) * Math.sin(2 * Math.PI * this.t / (this.asleep ? 3.8 : 2.6)) * (1 - st.g)
    // Postures: front and rear hip heights set the body's height and pitch.
    const hF = this.mode === 'hop' ? this.hopY : this.hF
    const hR = this.mode === 'hop' ? this.hopY : this.hR
    const pPitch = Math.asin(clamp((hR - hF) / (2 * DOG.hipZ), -0.9, 0.9))
    const wig = this.wiggleT > 0 ? Math.sin(2 * Math.PI * 3.2 * (HOP.wiggleT - this.wiggleT)) * (this.wiggleT / HOP.wiggleT) : 0
    const lat = this.shiftS.x
    p.yaw = st.yaw + this.bodyY.x + 0.05 * wig
    const c = Math.cos(st.yaw), s = Math.sin(st.yaw)
    p.x = st.bx + c * lat + s * this.shift
    p.z = st.bz - s * lat + c * this.shift
    p.y = (hF + hR) / 2 + DOG_GAIT.bob * bobN + this.sink.x + breath
    p.pitch = clamp(pPitch + DOG_GAIT.pitchPerSpeed * st.v + this.pitchKick.x + this.bodyP.x, -0.6, 0.6)
    p.roll = clamp(-DOG_GAIT.rollPerTurn * st.v * st.w / 0.3 + this.rollKick.x + 0.07 * wig - lat * 1.5, -0.3, 0.3)
    for (let i = 0; i < 4; i++) {
      const f = st.feet[i]!
      p.feet[i]!.x = f.x; p.feet[i]!.y = f.y; p.feet[i]!.z = f.z
    }
    p.k = 0
    p.headYaw = this.headY.x
    p.headPitch = this.headP.x
  }

  snapshot() {
    return JSON.stringify({
      cur: this.cur, st: this.stepper.snapshot(), mode: this.mode, posture: this.posture, t: this.t,
      p: [this.hF, this.hR, this.shift, this.pT, this.bowT, this.wiggleT], wall: [this.staticN, this.staticT, this.staticCool],
      springs: [this.sink, this.pitchKick, this.rollKick, this.headY, this.headP, this.bodyY, this.bodyP, this.shiftS].map(k => [k.x, k.v]),
      hop: [this.hopT, this.hopY, this.hopStage, this.hopQueued], sc: [this.script.i, this.script.t],
      ev: [this.touchdowns, this.thuds, this.hops],
    })
  }
}

const FK: LegFK = { hip: vec3(), thigh: vec3(), knee: vec3(), foot: vec3() }

/** Joint set for every leg from (abd for left legs, hip, knee); right legs mirror the abduction. */
function legs(f: (i: number, side: number) => [number, number, number]) {
  const q: number[] = []
  for (let i = 0; i < 4; i++) q.push(...f(i, legSide(i)))
  return q
}

/**
 * The fall and self-righting choreography (SCRIPTED). s = +1: it goes over
 * onto its left side. Roll about the body's long axis: Rz(roll < 0) tips the
 * top toward +X.
 */
export function fallKeys(s: number, twist: number): Key[] {
  const R = -s * Math.PI / 2
  const pose = (pitch: number, roll: number, yaw: number, q: number[], lift = 0): ScriptPose => ({ pitch, roll, yaw, q, lift })
  // Legs: the downhill pair stays bent under it, the uphill pair flails out.
  const splay = (flail: number) => legs((_i, side) => side === s ? [0, 0.65, -1.45] : [side * flail, 0.3, -0.85])
  const tuck = legs((_i, side) => side === s ? [0, 1.55, -2.6] : [s * 0.45, 1.55, -2.6])
  const crouch = legs(() => [0, 1.2, -2.5])
  return [
    { dur: 0.42, ease: 'in', tag: 'topple', pose: pose(0.04, R * 1.03, twist, splay(0.4)) },
    { dur: 0.12, ease: 'out', tag: 'impact', pose: pose(0.02, R * 0.9, twist, splay(0.6)) },
    { dur: 0.22, ease: 'inout', tag: 'settle', pose: pose(0, R, twist, splay(0.45)) },
    { dur: 0.75, ease: 'inout', tag: 'ground', pose: pose(0, R, twist, legs((_i, side) => side === s ? [0, 0.7, -1.3] : [side * 0.4, 0.4, -1.0])) },
    { dur: 0.38, ease: 'inout', tag: 'tuck', pose: pose(0, R * 0.95, twist, tuck) },
    { dur: 0.5, ease: 'inout', tag: 'roll', pose: pose(0, 0, twist, crouch) },
    { dur: 0.22, ease: 'out', tag: 'belly', pose: pose(0, 0, twist, crouch) },
    { dur: 0.75, ease: 'inout', tag: 'rise', pose: pose(0, 0, twist, crouch) },
  ]
}

export const FALL_TOTAL = fallKeys(1, 0).reduce((t, k) => t + k.dur, 0)
