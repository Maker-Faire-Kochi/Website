import { rng, type Rng } from '../core/rng'
import type { Dims } from './body'
import {
  apply, armMinReach, fkLeg, legRotations, mul, newLeg, rotX, rotY, rotZ, solveArm, solveLeg, transpose,
  type LegParams, type LegSolution, type Mat3, type Vec3,
} from './ik'

/**
 * The motion controller of one fair visitor, pure maths (no three.js): every
 * fixed step it produces a Pose -- the pelvis position and a local rotation
 * per bone -- which person.ts copies onto the skeleton and the tests check by
 * forward kinematics.
 *
 * How the body is driven, from the ground up:
 *  - FEET are world positions. They stay planted until a step moves them, and
 *    both legs are solved by closed-form IK from the pelvis to those soles
 *    every step, so a standing foot cannot slide and a sole cannot sink. The
 *    pelvis height is clamped so neither leg is ever asked to over-stretch:
 *    IK never clamps in normal motion, which is what keeps the feet exact.
 *  - the PELVIS and SPINE follow the current stance (stand, crouch, lean into
 *    a rope) through critically damped springs, plus idle breathing and a slow
 *    weight shift from foot to foot.
 *  - LOOKING is shared between pelvis, torso and head with natural limits, each
 *    on its own spring (head fast, torso slower), after a short per-person
 *    reaction delay, so a group turns to a sound as a ripple, not a drill.
 *  - HANDS are targets: hanging at the side, behind the back, clapping in front
 *    of the chest, waving above the shoulder, resting on the knees, gripping a
 *    rope, pointing at a world point. Each arm is a two-bone IK chain with a
 *    pole for the elbow. A change of action blends the hand from where it was
 *    to the new target along an eased arc around the shoulder (not a straight
 *    line through the body).
 *
 * World/parent frame: ground is y = 0, heading 0 faces +Z, positive heading
 * turns toward +X (rotation.y = heading). Body frame: the same axes rotated by
 * heading and divided by the person's scale, in the variant's own metres.
 */

export const BONE_NAMES = [
  'pelvis', 'spine', 'head',
  'upperArmL', 'lowerArmL', 'handL', 'upperArmR', 'lowerArmR', 'handR',
  'upperLegL', 'lowerLegL', 'footL', 'upperLegR', 'lowerLegR', 'footR',
  'skirt', 'skirtLow',
  'fingersL', 'fingersR',
  'clavicleL', 'clavicleR',
] as const
export const B = {
  pelvis: 0, spine: 1, head: 2,
  uaL: 3, faL: 4, handL: 5, uaR: 6, faR: 7, handR: 8,
  thL: 9, shL: 10, ftL: 11, thR: 12, shR: 13, ftR: 14,
  skirt: 15, skirtLow: 16,
  fiL: 17, fiR: 18,
  clL: 19, clR: 20,
} as const
/**
 * (The upper arms stay children of the spine. Each clavicle -- on the spine too -- turns
 * about the root of the neck as the arm rises past about 60 deg, the shoulder lifting and
 * coming forward; the upper arm's pivot moves with its outer end (its offset is updated
 * every step), and the shoulder's skin is shared between clavicle and upper arm.)
 */
export const PARENT = [-1, 0, 1, 1, 3, 4, 1, 6, 7, 0, 9, 10, 0, 12, 13, 0, 15, 5, 8, 1, 1]
export const BONE_COUNT = BONE_NAMES.length

/**
 * A long garment is two rigid pieces: the upper follows the thighs from the
 * hip axis to just above the knee, the lower hangs from there to the hem. So a
 * mundu or skirt drapes over the lap when sitting or crouching instead of
 * sticking out as one plank. A kurta's tail ends above the knee: upper only.
 */
export function skirtSplit(d: Dims) {
  return d.hem - 0.92 * d.L1 < 0.03 * d.H ? d.hem : 0.92 * d.L1
}

/** Rest translation of each bone in its parent (the pelvis's is dynamic). */
export function restOffsets(d: Dims): Vec3[] {
  return [
    [0, d.standY, 0],
    [0, d.waistY, 0],
    [0, d.spineLen, 0],
    [d.shoulderX, d.shoulderY, 0], [0, -d.UA, 0], [0, -d.FA, 0],
    [-d.shoulderX, d.shoulderY, 0], [0, -d.UA, 0], [0, -d.FA, 0],
    [d.hipW, 0, 0], [0, -d.L1, 0], [0, -d.L2, 0],
    [-d.hipW, 0, 0], [0, -d.L1, 0], [0, -d.L2, 0],
    [0, 0, 0],
    [0, -skirtSplit(d), 0],
    // The four fingers hinge together at the knuckles (curl toward the palm).
    [-0.0012 * d.H, -0.53 * d.hand, 0], [0.0012 * d.H, -0.53 * d.hand, 0],
    clavicleRoot(d, 1), clavicleRoot(d, -1),
  ]
}

/** Where a clavicle turns (spine frame): beside the root of the neck, at shoulder height. */
export function clavicleRoot(d: Dims, side: 1 | -1): Vec3 {
  return [side * 0.028 * d.H, d.shoulderY, 0.004 * d.H]
}

/** Clavicle at full shrug (an arm straight up): elevation and, for an arm raised forward, protraction (rad). */
export const SHRUG = { elevate: 0.42, protract: 0.3 }

export interface Pose {
  /** Pelvis origin in the body frame. */
  pelvisPos: Vec3
  /** Local rotation of every bone relative to its parent. */
  R: Mat3[]
  /** Breathing: the shoulders' small rise, added to both upper-arm offsets. */
  shoulderLift: number
  /** The garment's lower piece shortens when the knees are low (crouching or kneeling in a mundu), so its hem stays off the ground. */
  skirtScale: number
}

export type Stance = 'idle' | 'watch' | 'crouch' | 'point' | 'pull-rope'
export type OneShot = 'wave' | 'clap' | 'step-back'
export type Action = Stance | OneShot
export const STANCES: readonly Stance[] = ['idle', 'watch', 'crouch', 'point', 'pull-rope']
export const ONE_SHOTS: readonly OneShot[] = ['wave', 'clap', 'step-back']

export interface P3 { x: number, y: number, z: number }

/** How an idle, standing person rests their hands. */
type IdleHands = 'hang' | 'clasp' | 'hip' | 'pocket' | 'folded' | 'behind'

/** How the body is set for work. Changing it re-plants the feet one at a time. */
export type BodyStance = 'stand' | 'wide' | 'kneel' | 'sit'
export const BODY_STANCES: readonly BodyStance[] = ['stand', 'wide', 'kneel', 'sit']

/**
 * A world grip point for a hand: the palm centre is put exactly there. `normal`
 * (optional) is the surface normal at the grip, pointing out of the thing
 * gripped toward the hand: the palm then faces into it.
 */
export interface HandTarget {
  position: P3
  normal?: P3
  /** World direction the elbow should point (default: down and a little back and out). */
  elbow?: P3
  /**
   * World direction of the handle held (either sign). With an axis the fingers
   * run ACROSS it and wrap round it, the thumb closing on the other side.
   */
  axis?: P3
  /** 'wrap' (power grip, default with an axis), 'pinch' (thumb on nearly straight fingers: a blade, a line) or 'flat' (open hand pressing). */
  kind?: GripKind
  /** Handle radius, world units (default 0.015 x scale): how far the fingers curl. */
  radius?: number
}

export type GripKind = 'wrap' | 'pinch' | 'flat'

/** How a hand is to be oriented this step (spine frame): palm centre, hand X (side x palm normal) and Y (-fingers), finger curl. */
interface HandSpec { palm: Vec3, x: Vec3 | null, y: Vec3, curl: number, held: boolean, /** No handle axis: the hand stays in line with the forearm. */ free: boolean }

/** Wrist limits (a degree or two inside the 75 deg bend / 90 deg twist a check allows): the forearm takes twist up to 83 deg. */
export const WRIST = { bend: 74 * Math.PI / 180, hardBend: 75 * Math.PI / 180, forearmTwist: 1.45, twist: 88 * Math.PI / 180 }

/** Kneeling: toe tuck (foot pitch, rad) and the knee's ground position (fraction of height, behind the hips). */
const KNEEL_TOE = 1.15
const KNEEL_KNEE_Z = -0.03
/** Bounds of setLean (rad): forward / back, and sideways. */
export const LEAN = { forward: 0.6, back: -0.25, side: 0.3 }
/** Bounds of the automatic reach lean (rad) and the step a person takes toward work still out of reach. */
export const REACH_LEAN_MAX = 0.5

/**
 * How a look target competes with the hands. 'hands' (default): while a hand target is
 * set the eyes stay on the hands and only glance at the look target now and then.
 * 'target': the eyes stay on the look target, glancing at the hands while a hand travels
 * to a new grip (and on glanceAtHands()).
 */
export interface LookOptions { priority?: 'hands' | 'target' }

export interface PlayOptions {
  /** point: the world point to point at (and look at, unless look is false). crouch: the ground point to look at. */
  target?: P3
  /** step-back: the point to step away from. */
  from?: { x: number, z: number }
  /** step-back: distance to move, world units (default two steps, 0.2 x height x scale). */
  distance?: number
  /** point/wave: which hand (default: the side the target is on / right). */
  hand?: 'left' | 'right'
  /** point: also turn the head to the target (default true). */
  look?: boolean
  /** pull-rope: slope of the rope in front of the hauler, rad (+ rises away from them, - runs down to a cleat or stake). Default 0.1. */
  ropePitch?: number
  /** pull-rope: seconds per haul cycle when the scene does not drive ropePhase. Default 1.7. */
  ropePeriod?: number
}

// Natural limits, radians, relative to the parent segment.
export const LIMITS = {
  pelvisYaw: 0.22,
  torsoYaw: 0.62,
  headYaw: 1.2,
  headPitchUp: -0.55,
  headPitchDown: 0.75,
}

const DUR = { wave: 2.6, clap: 2.4, step: 2.0 }
const BLEND = 0.5
const TAU = Math.PI * 2

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
const smooth = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t) }
const smoother = (x: number) => { const t = clamp(x, 0, 1); return t * t * t * (t * (6 * t - 15) + 10) }
const bump = (x: number, a: number, b: number) => (x <= a || x >= b ? 0 : Math.sin(Math.PI * (x - a) / (b - a)) ** 2)
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const addv = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scl = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3): Vec3 => { const l = len(a); return l > 1e-12 ? scl(a, 1 / l) : a }
const col = (m: Mat3, j: number): Vec3 => [m[j]!, m[3 + j]!, m[6 + j]!]
const cols = (x: Vec3, y: Vec3, z: Vec3): Mat3 => [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]
/** Rotation by angle a about unit axis k (Rodrigues). */
function axisAngle(k: Vec3, a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c
  const [x, y, z] = k
  return [
    c + x * x * t, x * y * t - z * s, x * z * t + y * s,
    y * x * t + z * s, c + y * y * t, y * z * t - x * s,
    z * x * t - y * s, z * y * t + x * s, c + z * z * t,
  ]
}

/**
 * Split a hand's rotation relative to the (untwisted) forearm into a swing of
 * the hand's long axis and a twist about it; give the forearm as much of the
 * twist as it can take (pronation), clamp what the wrist keeps, clamp the bend.
 */
function limitWrist(rel0: Mat3, bendMax: number = WRIST.bend): { W: Mat3, ft: number, Hrel: Mat3, clamped: boolean } {
  let rel = rel0
  let clamped = false
  // Bend: the angle between the forearm's long axis and the hand's.
  const yh0 = col(rel, 1)
  const alpha = Math.acos(clamp(yh0[1], -1, 1))
  if (alpha > bendMax) {
    const k = cross(yh0, [0, 1, 0])
    const kl = len(k)
    const R = kl > 1e-9 ? axisAngle(scl(k, 1 / kl), alpha - bendMax) : rotX(alpha - bendMax)
    rel = mul(R, rel)
    clamped = true
  }
  const hy = col(rel, 1), hx = col(rel, 0), hz = col(rel, 2)
  // Twist, measured as the angle about the hand's long axis between the hand's X
  // and the forearm's X projected across it. The forearm turns (pronation and
  // supination) to cancel as much of it as it can.
  let ft = Math.atan2(hz[0], hz[2])
  if (Math.cos(ft) * hx[0] - Math.sin(ft) * hx[2] < 0) ft += Math.PI
  ft = Math.atan2(Math.sin(ft), Math.cos(ft))
  ft = clamp(ft, -WRIST.forearmTwist, WRIST.forearmTwist)
  const ex: Vec3 = [Math.cos(ft), 0, -Math.sin(ft)]
  const ref = sub(ex, scl(hy, dot(ex, hy)))
  const tw = Math.atan2(dot(cross(ref, hx), hy), dot(ref, hx))
  if (Math.abs(tw) > WRIST.twist) {
    rel = mul(axisAngle(hy, -(Math.abs(tw) - WRIST.twist) * Math.sign(tw)), rel)
    clamped = true
  }
  return { W: mul(rotY(-ft), rel), ft, Hrel: rel, clamped }
}

/** Blend two rotations by their Y and Z axes, re-orthonormalised (cheap and stable for small blends). */
/** Turn from A toward Bm by the fraction e of the angle between them, about their common axis (an even turn, however large). */
function slerpRot(A: Mat3, Bm: Mat3, e: number): Mat3 {
  const Q = mul(transpose(A), Bm)
  const c = clamp((Q[0] + Q[4] + Q[8] - 1) / 2, -1, 1)
  const th = Math.acos(c)
  if (th < 1e-4) return blendRot(A, Bm, e)
  let k: Vec3 = [Q[7] - Q[5], Q[2] - Q[6], Q[3] - Q[1]]
  if (len(k) < 1e-6) {
    // Half a turn: the axis from the diagonal.
    const d: Vec3 = [Math.sqrt(Math.max(0, (Q[0] + 1) / 2)), Math.sqrt(Math.max(0, (Q[4] + 1) / 2)), Math.sqrt(Math.max(0, (Q[8] + 1) / 2))]
    if (d[0] >= d[1] && d[0] >= d[2]) k = [d[0], Q[1] / (2 * d[0]), Q[2] / (2 * d[0])]
    else if (d[1] >= d[2]) k = [Q[1] / (2 * d[1]), d[1], Q[5] / (2 * d[1])]
    else k = [Q[2] / (2 * d[2]), Q[5] / (2 * d[2]), d[2]]
  }
  return mul(A, axisAngle(norm(k), e * th))
}

function blendRot(A: Mat3, Bm: Mat3, e: number): Mat3 {
  let y: Vec3 = [A[1] + (Bm[1] - A[1]) * e, A[4] + (Bm[4] - A[4]) * e, A[7] + (Bm[7] - A[7]) * e]
  const z0: Vec3 = [A[2] + (Bm[2] - A[2]) * e, A[5] + (Bm[5] - A[5]) * e, A[8] + (Bm[8] - A[8]) * e]
  const yl = len(y)
  if (yl < 1e-9) return Bm
  y = scl(y, 1 / yl)
  let x: Vec3 = [y[1] * z0[2] - y[2] * z0[1], y[2] * z0[0] - y[0] * z0[2], y[0] * z0[1] - y[1] * z0[0]]
  const xl = len(x)
  if (xl < 1e-9) return Bm
  x = scl(x, 1 / xl)
  const z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]
}

/** Critically damped spring; `snap` (poster mode) jumps to the target. */
class Spring {
  v = 0
  constructor(public x = 0, public w = 6) {}
  step(target: number, dt: number, snap = false) {
    if (snap) {
      this.x = target
      this.v = 0
      return this.x
    }
    // Semi-implicit Euler is stable here: w * dt <= 0.06 at DT = 5 ms.
    this.v += (this.w * this.w * (target - this.x) - 2 * this.w * this.v) * dt
    this.x += this.v * dt
    return this.x
  }
  limit(lo: number, hi: number) {
    if (this.x < lo) { this.x = lo; this.v = Math.max(0, this.v) }
    else if (this.x > hi) { this.x = hi; this.v = Math.min(0, this.v) }
  }
}

/** A world foot: sole centre, yaw, and pitch (toes down when kneeling). */
interface Foot { x: number, z: number, y: number, yaw: number, pitch: number }
interface ArmTarget { t: Vec3, pole: Vec3 }
interface ArmBlend {
  from: ArmTarget
  last: ArmTarget
  age: number
  wrist: Mat3
  fromWrist: Mat3
  dur: number
  e: number
  ft: number
  fromFt: number
  curl: number
  /** Hand orientation in the spine frame: now, at the blend's start, and at this step's start (rate limits). */
  hs: Mat3
  fromHs: Mat3
  prevHs: Mat3
  prevFt: number
  prevCurl: number
  prevPole: Vec3
  /** The palm this step and at its start (spine frame); lag: held back to a hand's speed. */
  out: Vec3 | null
  prevOut: Vec3 | null
  lag: boolean
  /** In the folded-arms rest pose this step; and whether the current blend started there. */
  folded: boolean
  fromFolded: boolean
  /** Going to a new grip: the palm's distance to it at the start, the hand's turn to make (rad, -1 until known) and how far it is. */
  d0: number
  theta0: number
  eRot: number
  rotAge: number
  /** Which way round the fingers wrap the current handle (1 or -1; 0: none yet). */
  fSign: 0 | 1 | -1
  fDir: Vec3 | null
  fFlip: boolean
  /** Wrist target (spine frame, from the shoulder) at this step's start. */
  prevT: Vec3
  /** Palm centre (spine frame) after the last step: where a grip's palm starts from. */
  palm: Vec3 | null
  /** On its grip (tracking it exactly), and where the grip was last step: only a jump of the grip is eased. */
  onGrip: boolean
  lastGoal: Vec3 | null
}

interface StepState {
  t: number
  dur: number
  p0: { x: number, z: number }
  p1: { x: number, z: number }
  first: 0 | 1
  from: [Foot, Foot]
  to: [Foot, Foot]
}

export class PersonMotion {
  /** Fastest a hand travels relative to the shoulder (world m/s), and whether hands are kept out of the head. */
  static HAND_SPEED = 2.6
  static HEAD_CLEARANCE = true
  readonly d: Dims
  readonly leg: LegParams
  readonly offsets: Vec3[]
  readonly pose: Pose
  readonly legs: [LegSolution, LegSolution] = [newLeg(), newLeg()]
  scale: number
  readonly pos = { x: 0, z: 0 }
  heading = 0
  /** World feet (index 0 = left). */
  readonly feet: [Foot, Foot] = [{ x: 0, z: 0, y: 0, yaw: 0, pitch: 0 }, { x: 0, z: 0, y: 0, yaw: 0, pitch: 0 }]
  /** Which feet are planted (on the ground and not moving) this step. */
  readonly planted: [boolean, boolean] = [true, true]

  stance: Stance = 'idle'
  oneShot: OneShot | null = null
  private stanceOpts: PlayOptions = {}
  private shotOpts: PlayOptions = {}
  private shotT = 0
  private queued: { name: OneShot, opts: PlayOptions } | null = null
  private stepS: StepState | null = null
  /** Rope phase in [0, 1); set from outside to sync with a scene, otherwise it free-runs. */
  ropePhase = 0
  ropeExternal = false
  ropePeriod = 1.7
  ropePitch = 0.1

  private t = 0
  private readonly R: Rng
  private readonly posterMode: boolean
  private readonly ph: { breath: number, sway: number, swayT: number, breathT: number, glance: number }

  // Look.
  private lookTarget: P3 | null = null
  private pendingLook: P3 | null | undefined = undefined
  private lookPriority: 'hands' | 'target' = 'hands'
  private pendingPriority: 'hands' | 'target' = 'hands'
  /** Until when (motion time) the eyes go to the hands although the look target has priority. */
  private handGlanceUntil = -1
  private lookDelay = 0
  readonly reaction: number
  private glance = { yaw: 0, pitch: 0, next: 0 }
  readonly pelvisYaw = new Spring(0, 3.2)
  readonly torsoYaw = new Spring(0, 5)
  readonly headYaw = new Spring(0, 10)
  readonly headPitch = new Spring(0, 10)

  // Body.
  private drop = new Spring(0, 5)
  private back = new Spring(0, 5)
  private pelvisPitch = new Spring(0, 5)
  private spinePitch = new Spring(0, 5)
  private spineRoll = new Spring(0, 4)
  private shift = new Spring(0, 4)
  /** Head centre (spine frame) and the closest a palm centre may come, this step. */
  private headC: Vec3 = [0, 0, 0]
  private headMin = 0
  private lookBend = new Spring(0, 4)
  /** How far each shoulder is shrugged (0..1), following its upper arm's raise. */
  private shrug = [new Spring(0, 9), new Spring(0, 9)]
  private shrugFwd = [0, 0]
  private headRoll = new Spring(0, 5)
  /**
   * Idle life: which leg carries the weight (+1 left, -1 right) and how the
   * hands rest, each changing now and then on a seeded timer.
   */
  private idleLife = { weight: 1 as 1 | -1, nextWeight: 0, hands: 'hang' as IdleHands, hipSide: 1 as 1 | -1, nextHands: 0 }

  private arms: [ArmBlend, ArmBlend]

  // Work: how the body is set (stand, wide, kneel, sit), world hand targets, lean.
  bodyStance: BodyStance = 'stand'
  /** Seat height for 'sit', in the body's own metres. */
  private seatH = 0
  /** Seated: height of the rung the feet rest on (body metres), 0 = the floor. */
  private footH = 0
  private pendingBody: { s: BodyStance, seat: number } | null = null
  readonly handT: [HandTarget | null, HandTarget | null] = [null, null]
  private userLean = { f: 0, s: 0 }
  private leanF = new Spring(0, 4)
  private leanS = new Spring(0, 4)
  private follow = new Spring(1, 4)
  /** Extra forward lean toward an out-of-reach hand target, rad. */
  reachLean = 0
  private reachStuck = 0
  /** Distance by which the furthest hand target is out of reach this step (body metres, <= 0 = reachable). */
  reachExcess = 0

  constructor(d: Dims, seed: number, opts: { posterMode?: boolean, scale?: number } = {}) {
    this.d = d
    this.leg = { hipW: d.hipW, L1: d.L1, L2: d.L2, ankleH: d.ankleH }
    this.offsets = restOffsets(d)
    this.scale = opts.scale ?? 1
    this.posterMode = !!opts.posterMode
    this.R = rng(seed * 7919 + 17)
    const r = this.R
    this.ph = {
      breath: r.range(0, TAU),
      sway: r.range(0, TAU),
      breathT: r.range(3.6, 4.8),
      swayT: r.range(6.5, 10),
      glance: r.range(0, 1),
    }
    this.reaction = r.range(0.06, 0.42)
    this.glance.next = r.range(0.5, 2.5)
    this.idleLife.weight = r.next() < 0.5 ? 1 : -1
    this.idleLife.nextWeight = r.range(3, 8)
    this.idleLife.hipSide = r.next() < 0.5 ? 1 : -1
    // Everyone starts in their own rest pose and changes on their own clock.
    this.idleLife.hands = this.pickIdleHands(r.next())
    this.idleLife.nextHands = r.range(2, 14)
    const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    this.pose = {
      pelvisPos: [0, d.standY, 0],
      R: Array.from({ length: BONE_COUNT }, () => I.slice() as Mat3),
      shoulderLift: 0,
      skirtScale: 1,
    }
    const restL = this.restArm(1)
    const restR = this.restArm(-1)
    this.arms = [
      { from: restL, last: restL, age: BLEND, wrist: rotX(0), fromWrist: rotX(0), dur: BLEND, e: 1, ft: 0, fromFt: 0, curl: 0.28, hs: rotX(0), fromHs: rotX(0), prevHs: rotX(0), prevFt: 0, prevCurl: 0.28, prevPole: restL.pole, out: null, prevOut: null, lag: false, folded: false, fromFolded: false, d0: 0, theta0: 0, eRot: 1, rotAge: 0, fSign: 0, fDir: null, fFlip: false, prevT: restL.t, palm: null, onGrip: false, lastGoal: null },
      { from: restR, last: restR, age: BLEND, wrist: rotX(0), fromWrist: rotX(0), dur: BLEND, e: 1, ft: 0, fromFt: 0, curl: 0.28, hs: rotX(0), fromHs: rotX(0), prevHs: rotX(0), prevFt: 0, prevCurl: 0.28, prevPole: restR.pole, out: null, prevOut: null, lag: false, folded: false, fromFolded: false, d0: 0, theta0: 0, eRot: 1, rotAge: 0, fSign: 0, fDir: null, fFlip: false, prevT: restR.t, palm: null, onGrip: false, lastGoal: null },
    ]
    this.placeAt(0, 0, 0)
  }

  get busy() {
    return this.stepS !== null
  }

  get action(): Action {
    return this.oneShot ?? this.stance
  }

  /** Distance the rope travels per haul cycle, world units (two hand strokes). */
  get ropeHaulPerCycle() {
    const r = this.ropeGeom()
    return 2 * (r.uFar - r.uNear) * this.scale
  }

  placeAt(x: number, z: number, heading: number) {
    this.pos.x = x
    this.pos.z = z
    this.heading = heading
    this.stepS = null
    for (const i of [0, 1] as const) Object.assign(this.feet[i], this.slot(i, x, z, heading))
    this.planted[0] = this.planted[1] = true
    this.solve(0, true)
  }

  /**
   * World look target (or null for the person's own idle glances). Takes effect after the
   * reaction delay. Given options, a target that moves on a little each call (a kite, a net
   * going down) is tracked as it moves; without them only a new or unchanged target lands
   * (a target that changes on every call keeps restarting the delay, as it always has).
   */
  lookAt(target: P3 | null, opts?: LookOptions) {
    if (target && !(Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z))) target = null
    const priority = target && opts?.priority === 'target' ? 'target' : 'hands'
    const same = !!target && !!this.lookTarget && target.x === this.lookTarget.x && target.y === this.lookTarget.y && target.z === this.lookTarget.z
    const near = (a: P3 | null | undefined) => {
      if (!target || !a) return false
      const gap = Math.hypot(target.x - a.x, target.y - a.y, target.z - a.z)
      return gap < Math.max(0.3, 0.2 * Math.hypot(target.x - this.pos.x, target.z - this.pos.z))
    }
    if (same) {
      if (this.pendingLook === undefined) this.lookPriority = priority
      return
    }
    if (opts && this.pendingLook === undefined && near(this.lookTarget)) {
      this.lookTarget = { x: target!.x, y: target!.y, z: target!.z }
      this.lookPriority = priority
      return
    }
    if (!target && !this.lookTarget && this.pendingLook === undefined) return
    if (opts && this.pendingLook !== undefined && (target ? near(this.pendingLook) : this.pendingLook === null)) {
      this.pendingLook = target ? { x: target.x, y: target.y, z: target.z } : null
      this.pendingPriority = priority
      return
    }
    this.pendingLook = target ? { x: target.x, y: target.y, z: target.z } : null
    this.pendingPriority = priority
    this.lookDelay = this.posterMode ? 0 : this.reaction
  }

  /** With a look target that has priority over the hands: look down at the hands for a moment. */
  glanceAtHands(seconds = 0.8) {
    if (Number.isFinite(seconds) && seconds > 0) this.handGlanceUntil = Math.max(this.handGlanceUntil, this.t + seconds)
  }

  play(name: Action, opts: PlayOptions = {}) {
    if ((STANCES as readonly string[]).includes(name)) {
      if (this.stance !== name || name === 'point' || name === 'crouch') this.blendArms()
      this.stance = name as Stance
      this.stanceOpts = opts
      if (name === 'point' && opts.target && opts.look !== false) this.lookAt(opts.target)
      if (name === 'crouch' && opts.target) this.lookAt(opts.target)
      if (name === 'pull-rope') {
        if (opts.ropePitch !== undefined && Number.isFinite(opts.ropePitch)) this.ropePitch = clamp(opts.ropePitch, -0.9, 0.9)
        if (opts.ropePeriod !== undefined && opts.ropePeriod > 0.3) this.ropePeriod = opts.ropePeriod
      }
      // A stance replaces a gesture in progress, but never a step: feet in the air finish their step.
      if (this.oneShot && this.oneShot !== 'step-back') this.oneShot = null
      return
    }
    const shot = name as OneShot
    if (this.stepS) {
      this.queued = { name: shot, opts }
      return
    }
    this.oneShot = shot
    this.shotOpts = opts
    this.shotT = 0
    this.blendArms()
    if (shot === 'step-back') this.beginStep(opts)
  }

  /**
   * Set the body for work. 'sit' needs `seatHeight` (world units, the seat's
   * top surface). Feet re-plant one at a time; if a step is in progress the
   * change waits for it. `instant` sets it at once (initial placement only).
   */
  setStance(stance: BodyStance, opts: { seatHeight?: number, footHeight?: number, instant?: boolean } = {}) {
    const seat = (opts.seatHeight ?? 0.45 * this.d.H * this.scale) / this.scale
    // Optional: the height of a stool rung the seated feet rest on (world units); default the floor.
    if (opts.footHeight !== undefined && Number.isFinite(opts.footHeight)) this.footH = Math.max(0, opts.footHeight / this.scale)
    if (stance === this.bodyStance && (stance !== 'sit' || Math.abs(seat - this.seatH) < 1e-6) && !this.pendingBody) return
    if (this.stepS) {
      this.pendingBody = { s: stance, seat }
      return
    }
    this.bodyStance = stance
    this.seatH = clamp(seat, 0.18 * this.d.H, 0.32 * this.d.H)
    if (this.posterMode || opts.instant) {
      for (const i of [0, 1] as const) Object.assign(this.feet[i], this.slot(i, this.pos.x, this.pos.z, this.heading))
      this.solve(0, true)
      return
    }
    this.beginReplant(stance)
  }

  /** World grip point for a hand, every step if it moves; null hands the arm back to its animation. */
  setHandTarget(side: 'left' | 'right', target: HandTarget | null) {
    const i = side === 'left' ? 0 : 1
    const had = this.handT[i] !== null
    const ok = (v?: P3) => !v || (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z))
    // A non-finite target is treated as none, so it can never poison the pose.
    if (target && !(ok(target.position) && ok(target.normal) && ok(target.elbow) && ok(target.axis))) target = null
    if (target) {
      const t = this.handT[i] ?? { position: { x: 0, y: 0, z: 0 } }
      t.position = { x: target.position.x, y: target.position.y, z: target.position.z }
      t.normal = target.normal ? { x: target.normal.x, y: target.normal.y, z: target.normal.z } : undefined
      t.elbow = target.elbow ? { x: target.elbow.x, y: target.elbow.y, z: target.elbow.z } : undefined
      t.axis = target.axis ? { x: target.axis.x, y: target.axis.y, z: target.axis.z } : undefined
      t.kind = target.kind === 'wrap' || target.kind === 'pinch' || target.kind === 'flat' ? target.kind : undefined
      t.radius = target.radius !== undefined && Number.isFinite(target.radius) && target.radius > 0 ? target.radius : undefined
      this.handT[i] = t
    }
    else {
      this.handT[i] = null
    }
    // Starting or ending a grip blends this arm; the other only when its pose may change
    // with it (a free hand at idle: rest poses need both hands free). A hand still at work
    // is left alone.
    if (had !== (target !== null)) {
      this.arms[i].fSign = 0
      this.blendArm(i)
      const o = i === 0 ? 1 : 0
      if (!this.handT[o] && this.stance === 'idle') this.blendArm(o)
    }
  }

  /** Lean the torso: forward (+) / back (-) and to the left (+) / right (-), radians, bounded. */
  setLean(forward: number, side = 0) {
    this.userLean.f = clamp(forward || 0, LEAN.back, LEAN.forward)
    this.userLean.s = clamp(side || 0, -LEAN.side, LEAN.side)
  }

  /** Clears queued reactions (pause). A step in progress finishes; it cannot be abandoned mid-air. */
  dropQueued() {
    this.queued = null
    this.pendingLook = undefined
  }

  setRopePhase(phase: number) {
    if (!Number.isFinite(phase)) return
    this.ropeExternal = true
    this.ropePhase = phase - Math.floor(phase)
  }

  step(dt: number) {
    const poster = this.posterMode
    if (!poster) this.t += dt
    // Look target after the reaction delay.
    if (this.pendingLook !== undefined) {
      this.lookDelay -= dt
      if (this.lookDelay <= 0) {
        this.lookTarget = this.pendingLook
        this.lookPriority = this.pendingPriority
        this.pendingLook = undefined
      }
    }
    if (this.oneShot) {
      this.shotT += poster ? 0 : dt
      const dur = this.oneShot === 'wave' ? DUR.wave : this.oneShot === 'clap' ? DUR.clap : DUR.step
      if (poster && this.oneShot !== 'step-back') this.shotT = dur * 0.4
      if (this.shotT >= dur && this.oneShot !== 'step-back') this.endShot()
    }
    if (this.stepS) this.advanceStep(poster ? 1e9 : dt)
    if (this.stance === 'pull-rope' && !this.ropeExternal && !poster) {
      this.ropePhase = (this.ropePhase + dt / this.ropePeriod) % 1
    }
    for (const a of this.arms) a.age += dt
    this.idleHands(poster)
    this.solve(dt, poster)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Relaxed and hanging most often; hands in pockets only where there are pockets. */
  private pickIdleHands(x: number): IdleHands {
    const pockets = this.d.lower === 'trousers' || this.d.lower === 'shorts'
    const table: [IdleHands, number][] = [['hang', 40], ['pocket', pockets ? 20 : 0], ['folded', 15], ['hip', 10], ['behind', 10], ['clasp', 5]]
    const total = table.reduce((a, [, w]) => a + w, 0)
    let v = x * total
    for (const [k, w] of table) {
      v -= w
      if (v < 0) return k
    }
    return 'hang'
  }

  /** Now and then an idle person rests their hands differently (seeded; arms blend over). */
  private idleHands(poster: boolean) {
    const life = this.idleLife
    if (poster || this.t < life.nextHands) return
    life.nextHands = this.t + this.R.range(8, 20)
    if (this.stance !== 'idle' || this.oneShot || this.stepS || this.handT[0] || this.handT[1]) return
    const next = this.pickIdleHands(this.R.next())
    if (next === life.hands) return
    if (next === 'hip') life.hipSide = this.R.next() < 0.5 ? 1 : -1
    life.hands = next
    this.blendArms()
  }

  /**
   * Where foot i stands, in the body frame, for a body stance: hip width
   * apart with a little toe-out; wide = a working straddle; sit = feet
   * forward under the knees; kneel = left foot forward flat, right knee down
   * with the shin along the ground and the toes tucked under.
   */
  slotLocal(i: 0 | 1, stance: BodyStance = this.bodyStance) {
    const d = this.d
    const side = i === 0 ? 1 : -1
    if (stance === 'wide') return { x: side * d.hipW * 2.1, y: 0, z: side * 0.012 * d.H, yaw: side * 0.28, pitch: 0 }
    if (stance === 'sit') {
      // On a rung the heels come back under the knees; on the floor the feet are a little forward.
      const onRung = this.footH > 0.02 * d.H
      return { x: side * d.hipW * 1.25, y: onRung ? this.footH : 0, z: (onRung ? 0.62 : 0.92) * d.L1, yaw: side * 0.12, pitch: 0 }
    }
    if (stance === 'kneel') {
      if (i === 0) return { x: d.hipW * 1.15, y: 0, z: 0.21 * d.H, yaw: 0.06, pitch: 0 }
      const k = KNEEL_TOE
      const toe = d.footLen - d.heel
      const ankleY = Math.max(d.calf * 0.5, d.ankleH * Math.cos(k) + toe * Math.sin(k)) + 0.004 * d.H
      const kz = KNEEL_KNEE_Z * d.H
      // Sole centre = ankle + Rx(k) (0, -ankleH, 0).
      return { x: -d.hipW * 1.05, y: ankleY - d.ankleH * Math.cos(k), z: kz - d.L2 * 0.995 - d.ankleH * Math.sin(k), yaw: -0.05, pitch: k }
    }
    return { x: side * d.hipW * 1.05, y: 0, z: side * 0.008 * d.H, yaw: side * 0.09, pitch: 0 }
  }

  private slot(i: 0 | 1, x: number, z: number, heading: number, stance: BodyStance = this.bodyStance): Foot {
    const l = this.slotLocal(i, stance)
    const s = this.scale
    const c = Math.cos(heading), sn = Math.sin(heading)
    return { x: x + (c * l.x + sn * l.z) * s, z: z + (-sn * l.x + c * l.z) * s, y: l.y * s, yaw: heading + l.yaw, pitch: l.pitch }
  }

  /** Move the feet, one at a time, to the slots of a new body stance (the body stays where it is). */
  private beginReplant(stance: BodyStance) {
    const to: [Foot, Foot] = [this.slot(0, this.pos.x, this.pos.z, this.heading, stance), this.slot(1, this.pos.x, this.pos.z, this.heading, stance)]
    const moved = (i: 0 | 1) => Math.hypot(to[i].x - this.feet[i].x, to[i].z - this.feet[i].z, to[i].y - this.feet[i].y) + Math.abs(to[i].pitch - this.feet[i].pitch) * 0.1
    this.stepS = {
      t: 0,
      dur: DUR.step * 1.1,
      p0: { x: this.pos.x, z: this.pos.z },
      p1: { x: this.pos.x, z: this.pos.z },
      first: moved(1) > moved(0) ? 1 : 0,
      from: [{ ...this.feet[0] }, { ...this.feet[1] }],
      to,
    }
  }

  private beginStep(opts: PlayOptions) {
    if (this.bodyStance === 'sit' || this.bodyStance === 'kneel') {
      this.oneShot = null
      return
    }
    const from = opts.from ?? { x: this.pos.x - Math.sin(this.heading), z: this.pos.z - Math.cos(this.heading) }
    let dx = this.pos.x - from.x
    let dz = this.pos.z - from.z
    const l = Math.hypot(dx, dz)
    if (l < 1e-6) { dx = -Math.sin(this.heading); dz = -Math.cos(this.heading) }
    else { dx /= l; dz /= l }
    // Two steps; each foot travels the whole distance, so keep it inside a comfortable stride.
    const D = Math.min(opts.distance ?? 0.2 * this.d.H * this.scale, 0.3 * this.d.H * this.scale)
    const p1 = { x: this.pos.x + dx * D, z: this.pos.z + dz * D }
    // The foot nearer the point we are leaving steps first.
    const along = (f: Foot) => (f.x - this.pos.x) * dx + (f.z - this.pos.z) * dz
    const first: 0 | 1 = along(this.feet[0]) <= along(this.feet[1]) ? 0 : 1
    this.stepS = {
      t: 0,
      dur: DUR.step,
      p0: { x: this.pos.x, z: this.pos.z },
      p1,
      first,
      from: [{ ...this.feet[0] }, { ...this.feet[1] }],
      to: [this.slot(0, p1.x, p1.z, this.heading), this.slot(1, p1.x, p1.z, this.heading)],
    }
  }

  /** Swing windows (fractions of the step) for the first and second foot. */
  static readonly SWING = [[0.12, 0.46], [0.54, 0.88]] as const

  private advanceStep(dt: number) {
    const s = this.stepS
    if (!s) return
    s.t = Math.min(s.dur, s.t + dt)
    const f = s.t / s.dur
    const k = smoother((f - 0.06) / 0.88)
    this.pos.x = s.p0.x + (s.p1.x - s.p0.x) * k
    this.pos.z = s.p0.z + (s.p1.z - s.p0.z) * k
    const lift = 0.035 * this.d.H * this.scale
    for (const i of [0, 1] as const) {
      const [a, b] = PersonMotion.SWING[i === s.first ? 0 : 1]
      const u = smoother((f - a) / (b - a))
      const foot = this.feet[i]
      const from = s.from[i], to = s.to[i]
      foot.x = from.x + (to.x - from.x) * u
      foot.z = from.z + (to.z - from.z) * u
      foot.yaw = from.yaw + wrap(to.yaw - from.yaw) * u
      foot.pitch = from.pitch + (to.pitch - from.pitch) * u
      foot.y = from.y + (to.y - from.y) * u + (f > a && f < b ? lift * Math.sin(Math.PI * u) : 0)
      this.planted[i] = !(f > a && f < b)
    }
    if (s.t >= s.dur) {
      this.stepS = null
      this.planted[0] = this.planted[1] = true
      if (this.oneShot === 'step-back') this.endShot()
      if (this.pendingBody) {
        const pb = this.pendingBody
        this.pendingBody = null
        this.setStance(pb.s, { seatHeight: pb.seat * this.scale })
      }
    }
  }

  private endShot() {
    this.oneShot = null
    this.blendArms()
    if (this.queued) {
      const q = this.queued
      this.queued = null
      this.play(q.name, q.opts)
    }
  }

  private blendArms() {
    this.blendArm(0)
    this.blendArm(1)
  }

  private blendArm(i: 0 | 1) {
    const a = this.arms[i]
    a.from = { t: a.last.t.slice() as Vec3, pole: a.last.pole.slice() as Vec3 }
    a.fromWrist = a.wrist.slice() as Mat3
    a.fromHs = a.hs.slice() as Mat3
    a.fromFt = a.ft
    a.fromFolded = a.folded
    a.age = 0
    a.dur = -1
    a.onGrip = false
    a.lastGoal = null
  }

  /**
   * Where the wrist goes this step (spine frame, relative to the shoulder): a
   * blend from where it was, on a straight path that goes round the body, the
   * elbow kept down; never faster than a hand really moves.
   */
  private pathTarget(i: 0 | 1, goal: ArmTarget, dt: number, snap: boolean): ArmTarget {
    const a = this.arms[i]
    const d = this.d, H = d.H
    if (snap) {
      a.e = 1
      a.last = goal
      return goal
    }
    if (a.dur < 0) {
      // Short moves are quick (a flinch takes 0.15 s), long ones take up to half a second.
      a.dur = clamp(0.1 + len(sub(goal.t, a.from.t)) / 1.4, 0.15, BLEND)
    }
    // Out of folded arms, a lower arm going up waits a moment for the top one (the left) to
    // clear; folding them, the top one waits for the lower one to be in place.
    const wait = (a.fromFolded && !a.folded && i === 1) || (a.folded && !a.fromFolded && i === 0)
    const age = wait ? Math.max(0, a.age - 0.15) : a.age
    const e = age >= a.dur ? 1 : smoother(age / a.dur)
    a.e = e
    let t = e < 1 ? addv(scl(a.from.t, 1 - e), scl(goal.t, e)) : goal.t
    let pole = e < 1 ? norm(addv(scl(norm(a.from.pole), 1 - e), scl(norm(goal.pole), e))) : goal.pole
    if (e < 1) {
      t = this.clearBody(i, t)
      // The elbow stays down on the way unless the hand is going above the shoulder.
      // (Only for a hand that actually travels: a re-blend to where the hand already is
      // must not drop the elbow -- folded arms would sag into each other.)
      if (goal.t[1] < 0.02 * H && pole[1] > -0.7 && !a.folded && !a.fromFolded && len(sub(goal.t, a.from.t)) > 0.03 * H) pole = norm([pole[0], -1.2, pole[2]])
      // Folding or unfolding the arms: the top forearm passes out over the other, which
      // drops a little, so the two never go through each other.
      if (a.fromFolded !== a.folded) {
        // (Clear early on the way out, late on the way in.)
        const w = Math.sin(Math.PI * e ** (a.folded ? 1.6 : 0.6))
        // (A lower arm going up dips under the top one first.)
        const rising = goal.t[1] > a.from.t[1] + 0.05 * H
        t = addv(t, scl(i === 0 ? [0, (a.folded ? 0.1 : 0.04) * H, 0.08 * H] : [0, (rising ? -0.07 : -0.04) * H, 0], w))
      }
    }
    // The elbow swivels at most ~8 rad/s.
    {
      const pp = norm(a.prevPole), pn = norm(pole)
      const ang = Math.acos(clamp(dot(pp, pn), -1, 1))
      const maxA = 8 * dt
      if (ang > maxA && dt > 0) pole = norm(addv(scl(pp, 1 - maxA / ang), scl(pn, maxA / ang)))
    }
    // A hand moves at most ~3 m/s (plus whatever the body does).
    const maxd = (PersonMotion.HAND_SPEED / this.scale) * dt
    const dv = sub(t, a.last.t)
    const dl = len(dv)
    if (dl > maxd && dt > 0) t = addv(a.last.t, scl(dv, maxd / dl))
    const target = { t, pole }
    a.last = target
    return target
  }

  /**
   * A gripping hand: the PALM moves toward the grip at most ~3 m/s (relative to
   * the shoulder) and lands on it exactly once there, so a moving tool is
   * tracked exactly and a new grip is reached, not jumped to. The wrist follows
   * from the hand's (rate-limited) orientation in solveArmPose.
   */
  private palmPath(i: 0 | 1, spec: HandSpec, goal: ArmTarget, dt: number, snap: boolean): ArmTarget {
    const a = this.arms[i]
    const d = this.d
    if (a.dur < 0) a.dur = clamp(0.1 + len(sub(goal.t, a.from.t)) / 1.4, 0.15, BLEND)
    a.e = snap || a.age >= a.dur ? 1 : smoother(a.age / a.dur)
    // The grip, kept within the arm's reach, out of the head and the body; the palm then travels toward it.
    let edge = false
    let headPushed = false
    {
      const side = i === 0 ? 1 : -1
      const S: Vec3 = this.shoulder(i)
      const w = sub(addv(spec.palm, scl(spec.y, 0.45 * d.hand)), S)
      const wl = len(w)
      const rMax = 0.9995 * (d.UA + d.FA), rMin = armMinReach(d.UA, d.FA) + 0.0005 * d.H
      const r = clamp(wl, rMin, rMax)
      if (wl > 1e-6 && r !== wl) spec.palm = sub(addv(S, scl(w, r / wl)), scl(spec.y, 0.45 * d.hand))
      // At the edge of reach the arm is near straight and the hand cannot follow a grip
      // exactly; there it follows at the capped speed instead.
      edge = wl > 0.98 * (d.UA + d.FA)
      // Inside the near limit (a grip right by the shoulder) the nearest reachable point
      // swings about as the grip passes the shoulder: follow that at the capped speed too.
      if (wl < rMin) edge = true
    }
    {
      const dv = sub(spec.palm, this.headC)
      const dl = len(dv)
      if (PersonMotion.HEAD_CLEARANCE && dl < this.headMin) {
        // Out along where the palm already is (a grip moving about inside the head must
        // not make the palm skid round it), else straight out.
        const from = a.palm ? sub(a.palm, this.headC) : dv
        const u = len(from) > 1e-6 ? scl(from, 1 / len(from)) : dl > 1e-6 ? scl(dv, 1 / dl) : [i === 0 ? 1 : -1, 0, 0] as Vec3
        spec.palm = addv(this.headC, scl(u, this.headMin))
        // Pushed off its grip: the palm moves at a hand's speed, and keeps to it until it
        // is back on the grip (the push lets go of it all at once).
        headPushed = true
      }
    }
    const goalPalm = spec.palm
    // A palm on its grip follows the grip exactly, however fast the tool moves --
    // unless the grip itself jumps (a new grip): then the palm travels to it.
    const jumped = !a.lastGoal || len(sub(goalPalm, a.lastGoal)) > (8 / this.scale) * dt
    // A hand going to a new grip draws the eyes for a moment.
    if (jumped && !snap) this.glanceAtHands(0.6)
    a.lastGoal = goalPalm
    // To a new grip the hand turns as it travels, arriving turned (not a moment later).
    if (snap || !a.palm) a.eRot = 1
    else if (jumped && dt > 0) {
      a.d0 = len(sub(goalPalm, a.palm))
      a.fromHs = a.hs.slice() as Mat3
      a.theta0 = -1
      a.eRot = 0
      a.rotAge = 0
    }
    if (!snap && a.palm && dt > 0 && !(a.onGrip && !jumped && !edge && !headPushed)) {
      const dv = sub(spec.palm, a.palm)
      const dl = len(dv)
      let maxd = (PersonMotion.HAND_SPEED / this.scale) * dt
      // A big turn over a short way: travel slower, so the turn keeps up (~9 rad/s).
      if (a.eRot < 1 && a.theta0 > 1e-3) maxd = Math.min(maxd, 9 * dt * a.d0 / a.theta0)
      a.onGrip = dl <= maxd
      if (dl > maxd) {
        let p = addv(a.palm, scl(dv, maxd / dl))
        // On the way, round the torso rather than through it (but never faster than the limit).
        const side = i === 0 ? 1 : -1
        const S: Vec3 = this.shoulder(i, false)
        const q = addv(this.clearBody(i, sub(p, S)), S)
        const qd = sub(q, a.palm)
        const ql = len(qd)
        p = ql > maxd ? addv(a.palm, scl(qd, maxd / ql)) : q
        spec.palm = p
      }
    }
    else if (snap || !a.palm) {
      a.onGrip = true
    }
    if (headPushed && !snap) a.onGrip = false
    if (a.eRot < 1) {
      // By the way gone -- and, should the palm be held up on the way (a grip the wrist
      // cannot take yet), by the time the trip should take, so the hand never stalls half-turned.
      a.rotAge += dt
      const trip = Math.max(a.d0 / (PersonMotion.HAND_SPEED / this.scale), Math.max(a.theta0, 0) / 9, 0.05)
      const byWay = a.d0 < 1e-6 ? 1 : 1 - len(sub(goalPalm, spec.palm)) / a.d0
      a.eRot = a.onGrip ? 1 : Math.max(a.eRot, clamp(byWay, 0, 1), clamp(a.rotAge / (1.25 * trip), 0, 1))
    }
    let pole = goal.pole
    if (!snap && dt > 0) {
      const pp = norm(a.prevPole), pn = norm(pole)
      const ang = Math.acos(clamp(dot(pp, pn), -1, 1))
      const maxA = 8 * dt
      if (ang > maxA) pole = norm(addv(scl(pp, 1 - maxA / ang), scl(pn, maxA / ang)))
    }
    const side = i === 0 ? 1 : -1
    const S: Vec3 = this.shoulder(i)
    const target = { t: sub(addv(spec.palm, scl(spec.y, 0.45 * d.hand)), S), pole }
    a.last = target
    return target
  }

  /** The shoulder joint (spine frame): shrugged with its clavicle, lifted with the breath. */
  private shoulder(i: 0 | 1, lift = true): Vec3 {
    const o = this.offsets[i === 0 ? B.uaL : B.uaR]!
    return [o[0], o[1] + (lift ? this.pose.shoulderLift : 0), o[2]]
  }

  /**
   * An arm raised forward or overhead past about 60 deg takes its shoulder with it: the
   * clavicle turns up (and forward, for an arm raised forward) about the root of the neck,
   * up to SHRUG at full raise, following last step's upper arm smoothly. The upper arm's
   * pivot sits on the clavicle's outer end, so the arm is solved from the shrugged shoulder.
   */
  private shrugShoulders(dt: number, snap: boolean) {
    const d = this.d, P = this.pose
    const rest = restOffsets(d)
    for (const i of [0, 1] as const) {
      const side: 1 | -1 = i === 0 ? 1 : -1
      const ua = i === 0 ? B.uaL : B.uaR
      const down = col(P.R[ua]!, 1) // the arm hangs along -Y: this is the upper arm's "up"
      const raise = Math.acos(clamp(down[1], -1, 1)) // 0 hanging, PI straight up
      // From about 60 deg the shoulder starts to lift (and, for an arm raised in front, to
      // come forward), fully by an arm straight up. A hand drawn in close (at the head)
      // needs no shrug, and would be pushed out of its reach by one.
      const tl = len(this.arms[i]!.last.t)
      const roomy = smoother((tl - armMinReach(d.UA, d.FA) - 0.03 * d.H) / (0.06 * d.H))
      // Nor one straining at full stretch toward work out of reach: there the lean and the
      // step do the reaching, and a shoulder moving under them would undo it.
      const strain = smoother((tl / (d.UA + d.FA) - 0.965) / 0.03) * smoother((this.reachExcess + 0.012 * d.H) / (0.01 * d.H))
      const target = smoother((raise - 1.2) / (2.75 - 1.2)) * roomy * (1 - strain)
      const sp = this.shrug[i]!
      const before = sp.x
      sp.step(target, dt, snap)
      if (!snap && dt > 0) sp.x = before + clamp(sp.x - before, -2.5 * dt, 2.5 * dt)
      sp.x = clamp(sp.x, 0, 1)
      // Forward: how much the raise is in front of the body (an arm raised out to the side lifts less forward).
      const fwd = smoother((-down[2] + 0.1) / 0.7)
      this.shrugFwd[i] = snap ? fwd : this.shrugFwd[i]! + (fwd - this.shrugFwd[i]!) * Math.min(1, 8 * dt)
      const s = sp.x
      const R = mul(rotY(-side * SHRUG.protract * s * this.shrugFwd[i]!), rotZ(side * SHRUG.elevate * s))
      P.R[i === 0 ? B.clL : B.clR] = R
      const c0 = clavicleRoot(d, side)
      const r0 = rest[ua]!
      this.offsets[ua] = addv(c0, apply(R, sub(r0, c0)))
    }
  }

  /** Hands behind the back: the wrists just outside the body's clearance (so blends to and from it stay smooth). */
  private behindBack(side: 1 | -1, S: Vec3): ArmTarget {
    const d = this.d, H = d.H
    const ax = d.torsoW * 0.95 + 0.025 * H, bz = d.torsoD * 0.5 + 0.03 * H
    const x = side * 0.055 * H
    const z = 0.004 * H - bz * Math.sqrt(Math.max(0, 1.08 ** 2 - (x / ax) ** 2))
    return { t: sub([x, 0.015 * H, z], S), pole: [side, -0.3, -0.7] }
  }

  /** Push a wrist point (relative to the shoulder) out of the torso, so a blend goes round the body. */
  private clearBody(i: 0 | 1, t: Vec3): Vec3 {
    const d = this.d, H = d.H
    const side = i === 0 ? 1 : -1
    const S: Vec3 = this.shoulder(i, false)
    const p = addv(S, t)
    if (p[1] < -0.08 * H || p[1] > d.spineLen) return t
    const ax = d.torsoW * 0.95 + 0.025 * H, bz = d.torsoD * 0.5 + 0.03 * H
    const r = Math.hypot(p[0] / ax, (p[2] - 0.004 * H) / bz)
    if (r >= 1.05) return t
    const k = 1.05 / Math.max(r, 1e-3)
    const q: Vec3 = r > 1e-3 ? [p[0] * k, p[1], 0.004 * H + (p[2] - 0.004 * H) * k] : [side * ax * 1.05, p[1], p[2]]
    return sub(q, S)
  }


  /**
   * Solve one arm to a wrist target and pose the hand: oriented to the grip
   * (wrist bend and twist limited, the forearm taking the twist), the fingers
   * curled for the grip. Returns the palm centre (spine frame).
   */
  private solveArmPose(i: 0 | 1, target: ArmTarget, spec: HandSpec | null, dt: number, snap: boolean): Vec3 {
    const a = this.arms[i]
    const d = this.d
    const P = this.pose
    const side: 1 | -1 = i === 0 ? 1 : -1
    const S: Vec3 = this.shoulder(i)
    let tt = target.t
    let sol = solveArm(tt, target.pole, d.UA, d.FA)
    let F0 = mul(sol.R, rotX(sol.elbow))
    // The hand's orientation in the spine frame (Hs). Free hands follow the forearm with a
    // little flex; a grip without a handle axis keeps the hand in line with the forearm
    // (laid flat on the surface when a normal is given); a handle grip is oriented by it.
    const handFrame = (F: Mat3): Mat3 => {
      let x = norm(spec?.x ?? col(F, 0))
      let y: Vec3
      if (!spec || spec.free) {
        // In line with the forearm, laid in the surface plane. When the forearm points
        // (nearly) straight into the surface its in-plane part is tiny and its direction
        // is noise: keep the hand's previous long axis there instead (blending smoothly),
        // or the hand would spin about the palm and the wrist jump side to side.
        const fy = col(F, 1)
        const inPlane = sub(fy, scl(x, dot(fy, x)))
        const prevY = col(a.prevHs, 1)
        const prevIn = sub(prevY, scl(x, dot(prevY, x)))
        const w = snap ? 1 : smoother((len(inPlane) - 0.12) / 0.33)
        y = addv(scl(len(inPlane) > 1e-9 ? norm(inPlane) : inPlane, w), scl(len(prevIn) > 1e-9 ? norm(prevIn) : prevIn, 1 - w))
        if (len(y) < 1e-6) y = len(inPlane) > 1e-9 ? inPlane : fy
      }
      else {
        y = sub(spec.y, scl(x, dot(spec.y, x)))
      }
      if (len(y) < 1e-6) y = col(F, 1)
      y = norm(y)
      x = norm(sub(x, scl(y, dot(x, y))))
      return cols(x, y, cross(x, y))
    }
    let Hs: Mat3
    if (!spec) {
      Hs = mul(F0, rotX(0.2 * sol.elbow))
    }
    else {
      // The wrist sits where the hand's orientation puts it, so the palm lands on the grip.
      Hs = handFrame(F0)
      for (let it = 0; it < 3; it++) {
        tt = sub(addv(spec.palm, scl(col(Hs, 1), 0.45 * d.hand)), S)
        sol = solveArm(tt, target.pole, d.UA, d.FA)
        F0 = mul(sol.R, rotX(sol.elbow))
        if (!spec.free) break
        Hs = handFrame(F0)
      }
    }
    const turnLimit = (H: Mat3): Mat3 => {
      // At most ~10 rad/s (in the spine frame, so a swivelling elbow does not swing the hand).
      if (snap || dt <= 0) return H
      let tr = 0
      for (let r = 0; r < 9; r++) tr += a.prevHs[r]! * H[r]!
      const turn = Math.acos(clamp((tr - 1) / 2, -1, 1))
      const maxTurn = 10 * dt
      return turn > maxTurn ? blendRot(a.prevHs, H, maxTurn / turn) : H
    }
    if (spec && a.theta0 < 0) {
      let tr = 0
      for (let r = 0; r < 9; r++) tr += a.fromHs[r]! * Hs[r]!
      a.theta0 = Math.acos(clamp((tr - 1) / 2, -1, 1))
      // The forearm's own turn (pronation) counts too: it goes at ~10 rad/s.
      a.theta0 = Math.max(a.theta0, 0.95 * Math.abs(limitWrist(mul(transpose(F0), Hs), WRIST.bend).ft - a.ft))
    }
    const eB = spec ? a.eRot : a.e
    if (!snap && eB < 1) Hs = spec ? slerpRot(a.fromHs, Hs, eB) : blendRot(a.fromHs, Hs, eB)
    let lim = limitWrist(mul(transpose(F0), Hs), WRIST.bend)
    let infeasible = false
    let HsT = Hs
    if (spec) {
      // Feasible first (wrist limits, with the wrist re-placed so the palm stays on the
      // grip), THEN the turn limit, then the wrist placed once more from the final hand.
      const place = () => {
        tt = sub(addv(spec.palm, scl(col(Hs, 1), 0.45 * d.hand)), S)
        sol = solveArm(tt, target.pole, d.UA, d.FA)
        F0 = mul(sol.R, rotX(sol.elbow))
        lim = limitWrist(mul(transpose(F0), Hs), WRIST.bend)
      }
      place()
      for (let it = 0; it < 8 && lim.clamped; it++) {
        Hs = blendRot(Hs, mul(F0, lim.Hrel), 0.7)
        place()
      }
      Hs = turnLimit(Hs)
      HsT = Hs
      tt = sub(addv(spec.palm, scl(col(Hs, 1), 0.45 * d.hand)), S)
      sol = solveArm(tt, target.pole, d.UA, d.FA)
      F0 = mul(sol.R, rotX(sol.elbow))
      // The loop aims a degree inside the limit; this last placement only clamps past the
      // limit itself, so a turning hand neither jumps nor over-bends.
      lim = limitWrist(mul(transpose(F0), Hs), WRIST.hardBend)
      for (let it = 0; it < 2 && lim.clamped; it++) {
        // Past the hard limit: take the limited hand and re-place the wrist, so the palm stays put.
        Hs = mul(F0, lim.Hrel)
        tt = sub(addv(spec.palm, scl(col(Hs, 1), 0.45 * d.hand)), S)
        sol = solveArm(tt, target.pole, d.UA, d.FA)
        F0 = mul(sol.R, rotX(sol.elbow))
        lim = limitWrist(mul(transpose(F0), Hs), WRIST.hardBend)
      }
      infeasible = lim.clamped
      a.last = { t: tt, pole: target.pole }
    }
    else {
      Hs = turnLimit(Hs)
      lim = limitWrist(mul(transpose(F0), Hs), WRIST.bend)
    }
    let ft = 0
    let W = rotX(0)
    let fore = W
    const wristFrom = (l: typeof lim) => {
      ft = l.ft
      if (!snap && dt > 0) ft = a.prevFt + clamp(ft - a.prevFt, -10 * dt, 10 * dt)
      W = mul(rotY(-ft), l.Hrel)
      // With the forearm still turning, keep the wrist's own twist inside its limit.
      const hy = col(W, 1), hx = col(W, 0)
      const ref = sub([1, 0, 0], scl(hy, hy[0]))
      const tw = Math.atan2(dot(cross(ref, hx), hy), dot(ref, hx))
      if (Math.abs(tw) > WRIST.twist) W = mul(axisAngle(norm(hy), -(Math.abs(tw) - WRIST.twist) * Math.sign(tw)), W)
      fore = mul(rotX(sol.elbow), rotY(ft))
    }
    wristFrom(lim)
    const palmOut = () => {
      const Fm = mul(sol.R, fore)
      return addv(addv(addv(S, apply(sol.R, [0, -d.UA, 0])), apply(Fm, [0, -d.FA, 0])), apply(mul(Fm, W), [0, -0.45 * d.hand, 0]))
    }
    let palm = palmOut()
    let lag = false
    if (spec && (infeasible || a.lag) && a.prevOut && !snap && dt > 0) {
      // A grip no wrist can take (a flat palm turned away right by the shoulder, say): the
      // wrist is re-placed from a clamped hand every step and the palm skips about. Move
      // the wrist instead so the palm travels no faster than a hand (the hand turned as
      // near its goal as the wrist allows), and catch up at that speed once it can.
      const maxd = 1.2 * (PersonMotion.HAND_SPEED / this.scale) * dt
      const resolve = (t: Vec3) => {
        tt = t
        sol = solveArm(tt, target.pole, d.UA, d.FA)
        F0 = mul(sol.R, rotX(sol.elbow))
        wristFrom(limitWrist(mul(transpose(F0), HsT), WRIST.hardBend))
        palm = palmOut()
        return len(sub(palm, a.prevOut!))
      }
      const t1 = tt
      let dl = len(sub(palm, a.prevOut))
      // Shift the wrist by the palm's excess (converges in a step or two)...
      for (let it = 0; it < 4 && dl > maxd * 1.001; it++) {
        lag = true
        const dv = sub(palm, a.prevOut)
        dl = resolve(addv(tt, sub(addv(a.prevOut, scl(dv, maxd / dl)), palm)))
      }
      if (dl > maxd * 1.05) {
        // ...unless the forearm swings with it (wrist close to the shoulder): then go only
        // part of the way from the last wrist position toward the new one.
        let lo = 0, hi = 1
        for (let it = 0; it < 10; it++) {
          const mid = 0.5 * (lo + hi)
          if (resolve(addv(a.prevT, scl(sub(t1, a.prevT), mid))) <= maxd) lo = mid
          else hi = mid
        }
        resolve(addv(a.prevT, scl(sub(t1, a.prevT), lo)))
      }
      a.last = { t: tt, pole: target.pole }
    }
    a.lag = lag
    a.out = palm
    a.wrist = W
    a.ft = ft
    a.hs = mul(F0, mul(rotY(ft), W))
    const base = i === 0 ? B.uaL : B.uaR
    P.R[base] = sol.R
    P.R[base + 1] = fore
    P.R[base + 2] = W
    const curlT = spec ? spec.curl : 0.28
    if (snap) a.curl = curlT
    else if (dt > 0) a.curl = a.prevCurl + (curlT - a.prevCurl) * Math.min(1, dt * 12)
    P.R[i === 0 ? B.fiL : B.fiR] = rotZ(-side * a.curl)
    return palm
  }

  private ropeGeom() {
    const H = this.d.H
    // The haul: hands meet the rope in front of the belly and draw it back to the waist.
    return { y: this.d.standY + this.d.waistY + 0.04 * H, z: 0.17 * H, uNear: -0.07 * H, uFar: 0.07 * H }
  }

  private restArm(side: 1 | -1): ArmTarget {
    const d = this.d
    const reach = d.UA + d.FA
    // Hanging clear of the thigh, the elbow a little back.
    return { t: [side * 0.045 * d.H, -0.975 * reach, 0.03 * d.H], pole: [side * 0.25, 0, -1] }
  }

  /**
   * Palm centre of a hand in the world, from the current step's pose (pure FK,
   * so anything tied to a hand -- a kite string, a rope -- stays deterministic).
   */
  handWorld(side: 'left' | 'right'): Vec3 {
    const P = this.pose
    const i = side === 'left' ? 0 : 1
    const ua = i === 0 ? B.uaL : B.uaR
    let R = P.R[B.pelvis]!
    let p = P.pelvisPos
    p = addv(p, apply(R, this.offsets[B.spine]!))
    R = mul(R, P.R[B.spine]!)
    const so = this.offsets[ua]!
    p = addv(p, apply(R, [so[0], so[1] + P.shoulderLift, so[2]]))
    R = mul(R, P.R[ua]!)
    p = addv(p, apply(R, this.offsets[ua + 1]!))
    R = mul(R, P.R[ua + 1]!)
    p = addv(p, apply(R, this.offsets[ua + 2]!))
    R = mul(R, P.R[ua + 2]!)
    p = addv(p, apply(R, [0, -this.d.hand * 0.45, 0]))
    return this.toWorld(p)
  }

  /** World point -> body frame (unscaled, heading removed). */
  toBody(p: P3): Vec3 {
    const dx = p.x - this.pos.x, dz = p.z - this.pos.z
    const c = Math.cos(this.heading), s = Math.sin(this.heading)
    return [(c * dx - s * dz) / this.scale, p.y / this.scale, (s * dx + c * dz) / this.scale]
  }

  /** Body frame -> world point. */
  toWorld(v: Vec3): Vec3 {
    const c = Math.cos(this.heading), s = Math.sin(this.heading)
    const x = v[0] * this.scale, z = v[2] * this.scale
    return [this.pos.x + c * x + s * z, v[1] * this.scale, this.pos.z - s * x + c * z]
  }

  private solve(dt: number, snap: boolean) {
    const d = this.d
    const H = d.H
    const P = this.pose
    const t = this.t
    const shot = this.oneShot
    // Stepping always stands the body up; the stance resumes after.
    const stance: Stance = shot === 'step-back' ? 'idle' : this.stance
    const idle = snap ? 0 : 1

    // ── Stance targets for the pelvis and spine ─────────────────────────
    let drop = 0, back = 0, pPitch = 0, sPitch = 0.025
    const rope = this.ropeGeom()
    if (stance === 'crouch') {
      drop = d.standY * 0.34
      back = -0.055 * H
      pPitch = 0.42
      sPitch = 0.38
    }
    else if (stance === 'watch') {
      sPitch = -0.035
    }
    else if (stance === 'point') {
      sPitch = 0.05
    }
    else if (stance === 'pull-rope') {
      drop = 0.035 * H
      back = -0.035 * H
      pPitch = -0.04
      // Lean in to reach for a fresh grip, lean back on each haul (two hauls per cycle).
      sPitch = -0.1 + 0.12 * Math.cos(2 * TAU * this.ropePhase)
    }
    if (shot === 'clap') sPitch += 0.02 * Math.sin(TAU * 2.5 * this.shotT)
    // The body stance sets the pelvis for work; sitting and kneeling hold it over the seat / the knee.
    const bs = this.bodyStance
    let follow = 1
    if (bs === 'wide') {
      drop = Math.max(drop, 0.045 * H)
    }
    else if (bs === 'sit') {
      follow = 0
      // Hip joints just above the seat so the thighs rest on it; the pelvis rolls
      // back a little and the back rounds forward over the work.
      drop = d.standY - (this.seatH + 0.056 * H)
      back = 0
      pPitch = -0.14
      sPitch = Math.max(sPitch, 0.16)
      if (stance === 'crouch') sPitch = 0.32
    }
    else if (bs === 'kneel') {
      follow = 0
      const k = this.slotLocal(1, 'kneel')
      const kneeY = k.y + d.ankleH * Math.cos(KNEEL_TOE)
      drop = d.standY - (kneeY + 0.985 * d.L1)
      back = KNEEL_KNEE_Z * H
      pPitch = 0.04
      if (stance === 'crouch') sPitch = 0.3
    }
    this.follow.step(follow, dt, snap)
    this.leanF.step(this.userLean.f, dt, snap)
    this.leanS.step(this.userLean.s, dt, snap)
    const breath = Math.sin(TAU * t / this.ph.breathT + this.ph.breath) * idle
    const swayK = shot === 'step-back' || bs === 'sit' || bs === 'kneel' || this.stepS ? 0 : (stance === 'crouch' || stance === 'pull-rope' || bs === 'wide' ? 0.25 : 1)
    const sway = Math.sin(TAU * t / this.ph.swayT + this.ph.sway) * Math.sin(TAU * t / (this.ph.swayT * 2.7) + 1.3) * idle * swayK
    // Weight on one leg (the hip over it, the other knee easing), changing sides
    // every several seconds: a person standing, not a mannequin.
    const life = this.idleLife
    if (!snap && t >= life.nextWeight) {
      if (swayK > 0) life.weight = life.weight === 1 ? -1 : 1
      life.nextWeight = t + this.R.range(5, 11)
    }

    // Weight onto the stance foot while the other one swings.
    let stepShift = 0
    const st = this.stepS
    if (st) {
      const f = st.t / st.dur
      const firstSide = st.first === 0 ? 1 : -1
      stepShift = -firstSide * bump(f, 0.02, 0.52) + firstSide * bump(f, 0.48, 0.98)
    }
    this.drop.step(drop, dt, snap)
    this.back.step(back, dt, snap)
    this.pelvisPitch.step(pPitch, dt, snap)
    this.spinePitch.step(sPitch, dt, snap)
    this.shift.step((0.5 * life.weight * idle + 0.18 * sway) * swayK * d.hipW + 0.55 * d.hipW * stepShift, dt, snap)

    // ── Look: split between pelvis, torso and head ──────────────────────
    let yawT: number, pitchT: number
    const eyeY = this.pose.pelvisPos[1] + d.waistY + d.spineLen + d.neck + 0.45 * d.headH
    const hands = this.handT.filter((h): h is HandTarget => h !== null)
    let look: P3 | null = this.lookTarget
    // Looking away from work in hand: the head turns, the body stays turned to the work
    // (turning it after the eyes would carry the hands off their grips).
    let work: { yaw: number, pitch: number } | null = null
    if (hands.length) {
      // Eyes on the work; a look target only gets a glance now and then -- or, given
      // priority, the look target holds the eyes and the hands get the glances.
      const glancing = this.lookTarget && (this.lookPriority === 'target'
        ? snap || t >= this.handGlanceUntil
        : !snap && ((t + this.ph.glance * 7) % 7) > 5.8)
      const n = hands.length
      const atHands = {
        x: hands.reduce((a, h) => a + h.position.x, 0) / n,
        y: hands.reduce((a, h) => a + h.position.y, 0) / n,
        z: hands.reduce((a, h) => a + h.position.z, 0) / n,
      }
      if (!glancing) look = atHands
      else {
        const v = this.toBody(atHands)
        work = { yaw: Math.atan2(v[0], v[2]), pitch: Math.atan2(eyeY - v[1], Math.max(0.05, Math.hypot(v[0], v[2]))) }
      }
    }
    if (look) {
      const v = this.toBody(look)
      yawT = Math.atan2(v[0], v[2])
      pitchT = Math.atan2(eyeY - v[1], Math.max(0.05, Math.hypot(v[0], v[2])))
    }
    else {
      // Idle glances, seeded.
      if (!snap && t >= this.glance.next) {
        const big = this.R.next() < 0.3
        this.glance.yaw = this.R.range(-1, 1) * (big ? 0.9 : 0.35)
        this.glance.pitch = this.R.range(-0.05, 0.25)
        this.glance.next = t + this.R.range(1.6, 4.5)
      }
      yawT = this.glance.yaw
      pitchT = stance === 'crouch' ? 0.95 : this.glance.pitch
    }
    if (shot === 'wave') pitchT -= 0.05
    const maxYaw = LIMITS.pelvisYaw + LIMITS.torsoYaw + LIMITS.headYaw
    yawT = clamp(wrap(yawT), -maxYaw, maxYaw)
    const bodyYawT = work ? clamp(wrap(work.yaw), -maxYaw, maxYaw) : yawT
    const pelvisYawT = clamp(0.12 * bodyYawT, -LIMITS.pelvisYaw, LIMITS.pelvisYaw)
    const torsoYawT = clamp(0.32 * bodyYawT, -LIMITS.torsoYaw, LIMITS.torsoYaw)
    const headYawT = clamp(yawT - pelvisYawT - torsoYawT, -LIMITS.headYaw, LIMITS.headYaw)
    this.pelvisYaw.step(pelvisYawT, dt, snap)
    this.torsoYaw.step(torsoYawT, dt, snap)
    this.headYaw.step(headYawT, dt, snap)
    this.pelvisYaw.limit(-LIMITS.pelvisYaw, LIMITS.pelvisYaw)
    this.torsoYaw.limit(-LIMITS.torsoYaw, LIMITS.torsoYaw)
    this.headYaw.limit(-LIMITS.headYaw, LIMITS.headYaw)
    // The torso bends a little toward what the eyes look down at.
    const lookBend = this.lookBend.step(clamp(0.18 * (work ? work.pitch : pitchT), -0.06, 0.18), dt, snap)
    const spineP = this.spinePitch.x + lookBend + 0.011 * breath + this.leanF.x + this.reachLean
    const headPitchT = clamp(pitchT - this.pelvisPitch.x - spineP, LIMITS.headPitchUp, LIMITS.headPitchDown)
    this.headPitch.step(headPitchT, dt, snap)
    this.headPitch.limit(LIMITS.headPitchUp, LIMITS.headPitchDown)

    // ── Pelvis pose ──────────────────────────────────────────────────────
    // Contrapposto: the hip over the standing leg rises, the shoulders answer the other way.
    const roll = this.shift.x / Math.max(1e-6, d.hipW) * 0.085
    const pelvisR = mul(mul(rotY(this.pelvisYaw.x), rotX(this.pelvisPitch.x)), rotZ(roll))
    // Body-frame soles.
    const soles: Vec3[] = []
    const soleR: Mat3[] = []
    for (const i of [0, 1] as const) {
      const f = this.feet[i]
      soles.push(this.toBody({ x: f.x, y: f.y, z: f.z }))
      soleR.push(mul(rotY(f.yaw - this.heading), rotX(f.pitch)))
    }
    // Midpoint of the feet carries the pelvis over its support.
    const mid: Vec3 = scl(addv(soles[0]!, soles[1]!), 0.5)
    const px = mid[0] * 0.6 * this.follow.x + this.shift.x
    const pz = mid[2] * 0.6 * this.follow.x + this.back.x
    let py = d.standY - this.drop.x - 0.004 * H * Math.abs(sway)
    // Never ask a leg to over-stretch: lower the pelvis instead, so IK stays exact.
    const kR = 0.9985 * (d.L1 + d.L2)
    for (const i of [0, 1] as const) {
      const side = i === 0 ? 1 : -1
      const ho = apply(pelvisR, [side * d.hipW, 0, 0])
      const ankle = addv(soles[i]!, apply(soleR[i]!, [0, d.ankleH, 0]))
      const dh2 = (px + ho[0] - ankle[0]) ** 2 + (pz + ho[2] - ankle[2]) ** 2
      const maxY = ankle[1] + Math.sqrt(Math.max(0, kR * kR - dh2)) - ho[1]
      if (py > maxY) py = maxY
    }
    P.pelvisPos[0] = px
    P.pelvisPos[1] = py
    P.pelvisPos[2] = pz
    P.R[B.pelvis] = pelvisR

    for (const i of [0, 1] as const) {
      const q = solveLeg(this.leg, P.pelvisPos, pelvisR, i === 0 ? 1 : -1, soles[i]!, soleR[i]!, this.legs[i])
      const [a, b, c] = legRotations(q)
      const base = i === 0 ? B.thL : B.thR
      P.R[base] = a
      P.R[base + 1] = b
      P.R[base + 2] = c
    }

    // ── Spine and head ───────────────────────────────────────────────────
    this.spineRoll.step(-0.6 * roll + this.leanS.x, dt, snap)
    const spineR = mul(mul(rotY(this.torsoYaw.x), rotX(spineP)), rotZ(this.spineRoll.x))
    P.R[B.spine] = spineR
    const headIdle = idle * 0.025 * Math.sin(TAU * t / 5.3 + this.ph.glance * 6)
    // The head stays nearly level over a tilted body, with a faint tilt of its own.
    this.headRoll.step(-0.7 * (roll + this.spineRoll.x) + 0.6 * headIdle, dt, snap)
    P.R[B.head] = mul(mul(rotY(this.headYaw.x + headIdle), rotX(this.headPitch.x + 0.3 * headIdle)), rotZ(this.headRoll.x))
    P.shoulderLift = 0.004 * H * breath
    this.shrugShoulders(dt, snap)

    // Spine frame in the body frame, for hand targets given in body space.
    const spineWorldR = mul(pelvisR, spineR)
    const spineOrigin = addv(P.pelvisPos, apply(pelvisR, this.offsets[B.spine]!))
    const toSpine = (v: Vec3): Vec3 => apply(transpose(spineWorldR), sub(v, spineOrigin))

    // ── Arms ─────────────────────────────────────────────────────────────
    const reach = d.UA + d.FA
    const hc = Math.cos(this.heading), hs = Math.sin(this.heading)
    let excess = -Infinity
    let near = -Infinity
    const dirToSpine = (w: P3): Vec3 => apply(transpose(spineWorldR), [hc * w.x - hs * w.z, w.y, hs * w.x + hc * w.z])
    const specs: (HandSpec | null)[] = [null, null]
    const goals: ArmTarget[] = []
    for (const i of [0, 1] as const) {
      const side: 1 | -1 = i === 0 ? 1 : -1
      const S: Vec3 = this.shoulder(i)
      let goal: ArmTarget = this.restArm(side)
      const hand = (o: PlayOptions, dflt: 'left' | 'right') => (o.hand ?? dflt) === (side === 1 ? 'left' : 'right')

      const ht = this.handT[i]
      this.arms[i].folded = false
      /**
       * The palm centre goes exactly on a grip point (spine frame). The hand's
       * orientation follows the grip: with a handle axis the fingers run ACROSS
       * it and wrap round it (or pinch it); otherwise they run along the reach
       * with the palm on the surface (today's behaviour).
       */
      const autoPole = { given: false }
      const headCtr = addv([0, d.spineLen, 0], apply(P.R[B.head]!, [0, d.neck + 0.5 * d.headH, 0.01 * H]))
      const grip = (tsp: Vec3, nb: Vec3 | null, pole: Vec3, kind?: GripKind, axis?: Vec3 | null, radius?: number) => {
        const v = sub(tsp, S)
        const l = len(v)
        const reachDir: Vec3 = l > 1e-9 ? scl(v, 1 / l) : [0, -1, 0]
        let n: Vec3 | null = null
        if (nb && len(nb) > 1e-9) n = scl(nb, 1 / len(nb))
        let ax: Vec3 | null = axis && len(axis) > 1e-9 ? scl(axis, 1 / len(axis)) : null
        if (!n && ax) {
          // No normal given: the palm comes at the handle from the shoulder's side.
          const w = sub(scl(v, -1), scl(ax, -dot(v, ax)))
          n = len(w) > 1e-9 ? scl(w, 1 / len(w)) : [0, 1, 0]
        }
        let f: Vec3 = reachDir
        // A hand at the head (a temple, an ear, the crown): the elbow comes out and forward,
        // about shoulder high, and the fingers run up and back along the head -- not a fist
        // folded tight at the shoulder with the forearm pressed to the upper arm.
        const hd = len(sub(tsp, headCtr))
        const atHead = smoother((d.headW * 0.5 + 0.08 * H - hd) / (0.05 * H))
        if (atHead > 0) {
          pole = norm(addv(scl(norm(pole), 1 - atHead), scl(norm([side * 0.9, -0.3, 0.75]), atHead)))
          f = norm(addv(scl(f, 1 - atHead), scl(norm([0, 0.75, -0.65]), atHead)))
        }
        const k: GripKind | 'legacy' = kind ?? (ax ? 'wrap' : 'legacy')
        if (ax && n && k !== 'flat') {
          // Across the handle: fingers square to both the axis and the palm normal.
          const ap = sub(ax, scl(n, dot(ax, n)))
          ax = len(ap) > 1e-6 ? scl(ap, 1 / len(ap)) : ax
          let c = cross(ax, n)
          if (len(c) > 1e-9) {
            c = scl(c, 1 / len(c))
            // Which way round the fingers go: the way the arm can take with the least turn
            // of the hand on the forearm (solved both ways). The other may need more turn
            // than forearm and wrist have, and the hand would flick between the two. Near a
            // tie, keep the way it already holds it.
            const cost = (ff: Vec3) => {
              const wp = sub(tsp, scl(ff, 0.45 * d.hand))
              let pl = pole
              if (!autoPole.given) {
                const ea = sub(sub(wp, scl(ff, d.FA)), S)
                const el = len(ea)
                if (el > 1e-6) pl = norm(addv(scl(ea, 0.65 / el), scl(norm(pole), 0.35)))
              }
              const so = solveArm(sub(wp, S), pl, d.UA, d.FA)
              const F = mul(so.R, rotX(so.elbow))
              const x = scl(n!, side), y = scl(ff, -1)
              const Hc = cols(x, y, cross(x, y))
              const rel = mul(transpose(F), Hc)
              return Math.acos(clamp((rel[0] + rel[4] + rel[8] - 1) / 2, -1, 1))
            }
            // Fingers on along the reach -- unless, when the hand takes hold (a new grip, one
            // that jumps, or a handle turned), that way round is clearly the harder one; then
            // the other way, for as long as it holds on.
            const arm = this.arms[i]
            const turned = !arm.fDir || Math.abs(dot(arm.fDir, c)) < 0.94
            let lg: 1 | -1 = dot(c, reachDir) >= 0 ? 1 : -1
            // (A handle straight across the reach is a tie: there the hand keeps its way round
            // unless the other is clearly easier -- it does not flip with every small sway.)
            let tie = false
            if (Math.abs(dot(c, reachDir)) < 0.06 && arm.fDir && !turned) {
              const held: Vec3 = dot(c, arm.fDir) >= 0 ? c : scl(c, -1)
              tie = true
              const keep = cost(held) <= cost(scl(held, -1)) + 0.1
              lg = (dot(keep ? held : scl(held, -1), c) >= 0 ? 1 : -1)
            }
            const fresh = !arm.fSign || turned || (!!arm.lastGoal && len(sub(tsp, arm.lastGoal)) > 0.03 * H)
            if (fresh && !tie) arm.fFlip = cost(scl(c, -lg)) < cost(scl(c, lg)) - 0.6
            const sg: 1 | -1 = tie ? lg : arm.fFlip ? (-lg as 1 | -1) : lg
            arm.fSign = sg
            arm.fDir = scl(c, sg)
            f = scl(c, sg)
          }
        }
        else if (n) {
          const pf = sub(f, scl(n, dot(f, n)))
          if (len(pf) > 1e-4) f = scl(pf, 1 / len(pf))
        }
        const rb = (radius ?? 0.015 * this.scale) / this.scale
        const curl = k === 'wrap' ? clamp(1.25 - 14 * (rb - 0.015), 0.55, 1.45)
          : k === 'pinch' ? 0.3
            : k === 'flat' ? 0.06
              : 0.7
        const wristP = sub(tsp, scl(f, 0.45 * d.hand))
        if (ax && !autoPole.given && k !== 'flat') {
          const elbowAt = sub(sub(wristP, scl(f, d.FA)), S)
          const el = len(elbowAt)
          if (el > 1e-6) pole = norm(addv(scl(elbowAt, 0.65 / el), scl(norm(pole), 0.35)))
        }
        goal = { t: sub(wristP, S), pole }
        specs[i] = { palm: tsp, y: scl(f, -1), x: n ? scl(n, side) : null, curl, held: true, free: !ax || k === 'flat' }
        const gl = len(goal.t)
        near = Math.max(near, armMinReach(d.UA, d.FA) + 0.02 * H - gl)
        return gl - 0.9995 * reach
      }
      if (ht) {
        const nb: Vec3 | null = ht.normal ? dirToSpine(ht.normal) : null
        // Elbow down (with gravity, whatever the lean), a little back and out: a
        // working arm, not a wing -- unless the scene says otherwise.
        // A hand raised above the shoulder takes its elbow out to the side and a little
        // forward (pointed down and back, it swung behind the head, out of sight).
        const tUp = smoother((toSpine(this.toBody(ht.position))[1] - S[1]) / (0.15 * H))
        const low = apply(transpose(spineWorldR), [side * 0.18, -1, -0.45])
        const pole: Vec3 = ht.elbow ? dirToSpine(ht.elbow) : tUp > 0 ? norm(addv(scl(norm(low), 1 - tUp), scl(norm([side, -0.15, 0.35]), tUp))) : low
        autoPole.given = !!ht.elbow
        excess = Math.max(excess, grip(toSpine(this.toBody(ht.position)), nb, pole, ht.kind, ht.axis ? dirToSpine(ht.axis) : null, ht.radius))
      }
      else if (shot === 'step-back') {
        // Walking: the arms swing from the shoulder against the legs, clear of the thighs.
        const st2 = this.stepS
        const f = st2 ? st2.t / st2.dur : 0
        const swing = 0.085 * H * (bump(f, 0.08, 0.5) - bump(f, 0.5, 0.92)) * side * (st2?.first === 0 ? 1 : -1)
        goal = { t: addv(goal.t, [side * 0.012 * H, 0.012 * H + Math.abs(swing) * 0.25, swing]), pole: [side * 0.3, -0.2, -1] }
      }
      else if (shot === 'clap') {
        const env = smooth(this.shotT / 0.35) * smooth((DUR.clap - this.shotT) / 0.35)
        const g = 0.15 * H * (1 - env + env * Math.abs(Math.sin(Math.PI * 2.5 * this.shotT)) ** 0.8)
        // The palms meet but never pass through each other.
        const c: Vec3 = [side * (g / 2 + 0.03 * H), 0.1 * H, 0.2 * H]
        goal = { t: sub(c, S), pole: [side, -1, -0.25] }
      }
      else if (shot === 'wave' && hand(this.shotOpts, 'right')) {
        // The wave builds up and dies away rather than starting at full swing.
        const env = smooth(this.shotT / 0.45) * smooth((DUR.wave - this.shotT) / 0.45)
        const k = Math.sin(TAU * 1.8 * this.shotT) * env
        goal = { t: [side * (0.16 * H + 0.06 * H * k), 0.19 * H, 0.04 * H], pole: [side, -1.2, 0.1] }
      }
      // Rest poses only with both hands free: one hand at work keeps the other simply hanging.
      else if (stance === 'idle' && !snap && (this.bodyStance === 'stand' || this.bodyStance === 'wide') && !this.handT[0] && !this.handT[1]) {
        const life = this.idleLife
        if (life.hands === 'clasp') {
          // Hands loosely together in front of the belly.
          const c: Vec3 = [side * 0.03 * H, -0.015 * H, d.torsoD / 2 + 0.04 * H]
          goal = { t: sub(c, S), pole: [side * 0.8, -0.7, -0.5] }
        }
        else if (life.hands === 'hip' && side === life.hipSide) {
          // One hand resting on the hip, elbow out.
          const c: Vec3 = [side * (d.torsoW * 0.86 + 0.02 * H), 0.03 * H, -0.004 * H]
          goal = { t: sub(c, S), pole: [side, 0.05, -0.35] }
        }
        else if (life.hands === 'pocket') {
          // Hands in the front pockets: the palm on the front of the hip, elbows out and back.
          const c: Vec3 = [side * (d.hipW + d.thigh * 0.45), -0.045 * H, 0.045 * H * d.build + 0.012 * H]
          goal = { t: sub(addv(c, [0, 0.45 * d.hand, 0]), S), pole: [side * 0.9, -0.4, -0.8] }
        }
        else if (life.hands === 'folded') {
          this.arms[i].folded = true
          // Arms folded: each hand at the other arm, the left forearm over (above and in
          // front of) the right, a forearm's thickness clear of it where they cross.
          const c: Vec3 = side === 1
            ? [-0.035 * H, 0.38 * d.spineLen + 0.05 * H, d.torsoD / 2 + 0.1 * H]
            : [0.035 * H, 0.38 * d.spineLen - 0.01 * H, d.torsoD / 2 + 0.04 * H]
          goal = { t: sub(c, S), pole: [side, -1, 0.35] }
        }
        else if (life.hands === 'behind') {
          goal = this.behindBack(side, S)
        }
        else {
          // Hanging relaxed, the elbows a little bent, swinging a hair with the weight shift.
          goal = { t: addv(goal.t, [0, 0.008 * H, 0.004 * H + 0.006 * H * Math.sin(TAU * t / this.ph.swayT + this.ph.sway + side)]), pole: goal.pole }
        }
      }
      else if (stance === 'watch') {
        goal = this.behindBack(side, S)
      }
      else if (stance === 'crouch') {
        // Rest on the thigh just above the knee.
        const legI = i
        const fk = fkLeg(this.leg, P.pelvisPos, pelvisR, side, this.legs[legI])
        const thighR = mul(pelvisR, P.R[legI === 0 ? B.thL : B.thR]!)
        const onKnee = addv(fk.knee, apply(thighR, [0, 0.07 * H, d.thigh * 0.5 + 0.012 * H]))
        goal = { t: sub(toSpine(onKnee), S), pole: [side, -0.3, -0.35] }
      }
      else if (stance === 'point' && this.stanceOpts.target) {
        const tgt = this.toBody(this.stanceOpts.target)
        const autoHand = tgt[0] >= 0 ? 'left' : 'right'
        if (hand(this.stanceOpts, autoHand)) {
          const v = sub(toSpine(tgt), S)
          const l = len(v)
          goal = { t: l > 1e-6 ? scl(v, Math.min(l, 0.985 * reach) / l) : goal.t, pole: [side * 0.4, -1, -0.3] }
        }
      }
      else if (stance === 'pull-rope') {
        const ph = (this.ropePhase + (i === 0 ? 0 : 0.5)) % 1
        let u: number, up = 0, out = 0
        if (ph < 0.5) {
          u = rope.uFar + (rope.uNear - rope.uFar) * (ph / 0.5)
        }
        else {
          const q = smooth((ph - 0.5) / 0.5)
          u = rope.uNear + (rope.uFar - rope.uNear) * q
          up = 0.06 * H * Math.sin(Math.PI * q)
          out = 0.05 * H * Math.sin(Math.PI * q)
        }
        const cp = Math.cos(this.ropePitch), sp = Math.sin(this.ropePitch)
        const onRope: Vec3 = [side * (0.022 * H + out), rope.y + u * sp + up, rope.z + u * cp]
        // Overhand: palm on top of the rope, fingers wrapped under it.
        const ropeDir = apply(transpose(spineWorldR), [0, sp, cp])
        const upN = apply(transpose(spineWorldR), [0, 1, 0])
        grip(toSpine(onRope), upN, [side, -1, -0.3], 'wrap', ropeDir, 0.012 * this.scale)
      }
      goals.push(goal)
    }

    // Blend, rate-limit and solve both arms; then keep hands out of the head and apart.
    this.headC = addv([0, d.spineLen, 0], apply(P.R[B.head]!, [0, d.neck + 0.5 * d.headH, 0.01 * H]))
    this.headMin = d.headW * 0.5 * 1.05 + 0.011 * H + 0.005 / this.scale
    for (const a of this.arms) {
      a.prevHs = a.hs
      a.prevFt = a.ft
      a.prevCurl = a.curl
      a.prevPole = a.last.pole
      a.prevOut = a.out
      a.prevT = a.last.t
    }
    const palms: Vec3[] = []
    for (const i of [0, 1] as const) {
      const spec = specs[i] ?? null
      const target = spec ? this.palmPath(i, spec, goals[i]!, dt, snap) : this.pathTarget(i, goals[i]!, dt, snap)
      palms.push(this.solveArmPose(i, target, spec, dt, snap))
    }
    const headC = this.headC, headMin = this.headMin
    // A push out of the head or off the other hand moves the wrist on, but no further this
    // step than a hand travels (the push and the path together, not each on its own).
    const nudge = (i: 0 | 1, v: Vec3) => {
      const a = this.arms[i]
      let t = addv(a.last.t, v)
      if (!snap && dt > 0) {
        const dv = sub(t, a.prevT)
        const dl = len(dv)
        const maxd = (PersonMotion.HAND_SPEED / this.scale) * dt
        if (dl > maxd) t = addv(a.prevT, scl(dv, maxd / dl))
      }
      a.last = { t, pole: a.last.pole }
    }
    for (const i of [0, 1] as const) {
      if (specs[i]) continue // a gripping palm is kept out of the head on its path (palmPath)
      const p = palms[i]!
      const dv = sub(p, headC)
      const dl = len(dv)
      if (PersonMotion.HEAD_CLEARANCE && dl < headMin) {
        const n = dl > 1e-6 ? scl(dv, 1 / dl) : [this.arms[i].last.t[0] >= 0 ? 1 : -1, 0, 0] as Vec3
        const a = this.arms[i]
        // Out of the head, but no faster than a hand moves (a bumped head nudges the hand away).
        const push = Math.min(headMin - dl, (PersonMotion.HAND_SPEED / this.scale) * Math.max(dt, 1e-9))
        nudge(i, scl(n, snap ? headMin - dl : push))
        palms[i] = this.solveArmPose(i, a.last, specs[i] ?? null, dt, snap)
      }
    }
    if (!this.handT[0] && !this.handT[1]) {
      const minGap = 0.026 * H
      const dv = sub(palms[0]!, palms[1]!)
      const dl = len(dv)
      if (dl < minGap) {
        const n: Vec3 = dl > 1e-6 ? scl(dv, 1 / dl) : [1, 0, 0]
        for (const i of [0, 1] as const) {
          const a = this.arms[i]
          const push = Math.min(0.5 * (minGap - dl), (PersonMotion.HAND_SPEED / this.scale) * Math.max(dt, 1e-9))
          nudge(i, scl(n, (i === 0 ? 1 : -1) * (snap ? 0.5 * (minGap - dl) : push)))
          palms[i] = this.solveArmPose(i, a.last, specs[i] ?? null, dt, snap)
        }
      }
    }

    this.arms[0].palm = palms[0]!
    this.arms[1].palm = palms[1]!

    // ── Out of reach: lean toward the work, and if that is not enough, step to it ─
    this.reachExcess = Math.max(excess, near)
    if (!snap) {
      // Too far: lean in. Too close (the elbow cannot fold further): lean back a little.
      if (excess > 0) this.reachLean = Math.min(REACH_LEAN_MAX, this.reachLean + Math.min(1, 8 * excess / H) * dt)
      else if (near > 0) this.reachLean = Math.max(-0.2, this.reachLean - Math.min(1, 8 * near / H) * dt)
      else if (excess < -0.03 * H && near < -0.01 * H) this.reachLean -= Math.sign(this.reachLean) * Math.min(Math.abs(this.reachLean), 0.35 * dt)
      const canStep = (this.bodyStance === 'stand' || this.bodyStance === 'wide') && !this.stepS && !this.oneShot
      if (excess > 0.02 * H && this.reachLean >= REACH_LEAN_MAX - 1e-6 && canStep) this.reachStuck += dt
      else this.reachStuck = 0
      if (this.reachStuck > 0.5) {
        this.reachStuck = 0
        const tg = this.handT.filter((h): h is HandTarget => h !== null)
        const n = tg.length
        const gx = tg.reduce((q, h) => q + h.position.x, 0) / n - this.pos.x
        const gz = tg.reduce((q, h) => q + h.position.z, 0) / n - this.pos.z
        const gl = Math.hypot(gx, gz)
        if (gl > 1e-6) {
          this.play('step-back', {
            from: { x: this.pos.x - gx / gl, z: this.pos.z - gz / gl },
            distance: Math.min((excess + 0.03 * H) * this.scale, 0.25 * H * this.scale),
          })
        }
      }
    }

    // ── Long garment: follows the thighs, shortens if it would touch the ground ─
    const thighs = (this.legs[0].hipPitch + this.legs[1].hipPitch) / 2
    // The upper piece (or a kurta's front panel) drapes over the thighs.
    // Standing (thighs near plumb) the cloth hangs straight; it follows the thighs once they lift.
    const upper = clamp(0.9 * thighs * smooth((Math.abs(thighs) - 0.08) / 0.4), -1.75, 0.4)
    P.R[B.skirt] = rotX(upper)
    // The lower piece hangs plumb from the knees.
    const tilt = this.pelvisPitch.x + upper
    P.R[B.skirtLow] = rotX(-tilt)
    const lowLen = d.hem - skirtSplit(d)
    if (lowLen > 0) {
      const kneeY = py - skirtSplit(d) * Math.cos(tilt)
      const clear = 0.02 * H
      P.skirtScale = kneeY - lowLen >= clear ? 1 : clamp((kneeY - clear) / lowLen, 0.15, 1)
    }
  }
}
