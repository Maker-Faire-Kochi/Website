import { apply, mul, rotX, rotY, rotZ, transpose, type Mat3, type Vec3 } from '../robots/duck/ik'

/**
 * Closed-form limb IK for the people, pure maths (no three.js) so the motion
 * controller, the renderer and the tsx tests all solve the same chains.
 *
 * Frames match the duck's (robots/duck/ik.ts, whose rotation helpers this
 * reuses): +Y up, a figure faces +Z, +X is its LEFT; Rx(a > 0) tips +Y toward
 * +Z. A limb hangs along its bone's -Y, so Rx(a > 0) swings it BACKWARD.
 *
 * LEG: the duck's 6-DOF chain (hip yaw -> roll -> pitch -> knee -> ankle pitch
 * -> roll, Kajita's analytic solution) with two human differences: the knee
 * bends FORWARD (knee > 0: the shin swings back under the thigh), and the
 * reach clamp sits almost at full stretch, because a human stands on a nearly
 * straight knee -- the duck's 0.97 * reach would mean a 28 deg crouch.
 *
 * ARM: a 3-DOF shoulder and a hinge elbow. The swivel of the elbow around the
 * shoulder-hand line is not determined by the target, so the caller gives a
 * POLE direction the elbow should point toward (down-and-back at rest, out to
 * the side when clapping). The upper arm frame is built directly: its -Y runs
 * down the upper arm, its X is the elbow hinge, its +Z is the side the forearm
 * folds toward -- so the elbow is a single Rx(elbow), elbow <= 0.
 */

export type { Mat3, Vec3 }
export { apply, mul, rotX, rotY, rotZ, transpose }

const deg = Math.PI / 180
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

export interface LegParams {
  /** Hip joint offset from the pelvis origin along the pelvis X axis. */
  hipW: number
  L1: number
  L2: number
  /** Ankle axis height above the sole. */
  ankleH: number
}

/** Human knee: the reach clamp leaves ~4 deg of bend at full stretch. */
export const LEG_STRETCH = 0.9995
export const LEG_LIMITS = {
  hipYaw: [-50 * deg, 50 * deg],
  hipRoll: [-35 * deg, 35 * deg],
  hipPitch: [-125 * deg, 45 * deg],
  knee: [0, 150 * deg],
  anklePitch: [-55 * deg, 55 * deg],
  ankleRoll: [-30 * deg, 30 * deg],
} as const

export const LEG_JOINTS = ['hipYaw', 'hipRoll', 'hipPitch', 'knee', 'anklePitch', 'ankleRoll'] as const

export interface LegAngles {
  hipYaw: number
  hipRoll: number
  hipPitch: number
  knee: number
  anklePitch: number
  ankleRoll: number
}

export interface LegSolution extends LegAngles {
  dist: number
  clamped: boolean
  limited: boolean
}

export function newLeg(): LegSolution {
  return { hipYaw: 0, hipRoll: 0, hipPitch: 0, knee: 0, anklePitch: 0, ankleRoll: 0, dist: 0, clamped: false, limited: false }
}

export function legReach(p: LegParams) {
  return { min: Math.abs(p.L1 - p.L2) + 0.1 * (p.L1 + p.L2), max: LEG_STRETCH * (p.L1 + p.L2) }
}

/** Solve one leg; side +1 = left (+X). Pelvis and sole are poses in the same frame. */
export function solveLeg(
  p: LegParams, pelvisPos: Vec3, pelvisR: Mat3, side: 1 | -1,
  solePos: Vec3, soleR: Mat3, out: LegSolution = newLeg(),
): LegSolution {
  const { L1, L2 } = p
  const ho = apply(pelvisR, [side * p.hipW, 0, 0])
  const ao = apply(soleR, [0, p.ankleH, 0])
  const d: Vec3 = [
    pelvisPos[0] + ho[0] - solePos[0] - ao[0],
    pelvisPos[1] + ho[1] - solePos[1] - ao[1],
    pelvisPos[2] + ho[2] - solePos[2] - ao[2],
  ]
  let r = apply(transpose(soleR), d)
  const D = Math.hypot(r[0], r[1], r[2])
  out.dist = D
  out.clamped = false
  out.limited = false
  if (!(D > 1e-9)) {
    out.hipYaw = out.hipRoll = out.hipPitch = out.anklePitch = out.ankleRoll = 0
    out.knee = 10 * deg
    out.clamped = true
    return out
  }
  const reach = legReach(p)
  const Dc = clamp(D, reach.min, reach.max)
  if (Dc !== D) {
    out.clamped = true
    r = [r[0] * Dc / D, r[1] * Dc / D, r[2] * Dc / D]
  }
  // Dc^2 = L1^2 + L2^2 + 2 L1 L2 cos(knee); the human knee takes the positive root.
  const knee = Math.acos(clamp((Dc * Dc - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1))
  const ankleRoll = Math.atan2(r[0], r[1])
  const wy = Math.hypot(r[0], r[1])
  const vy = L1 * Math.cos(knee) + L2
  const vz = -L1 * Math.sin(knee)
  const anklePitch = Math.atan2(vz, vy) - Math.atan2(r[2], wy)
  const M = mul(mul(mul(transpose(pelvisR), soleR), rotZ(-ankleRoll)), rotX(-(knee + anklePitch)))
  out.hipRoll = Math.asin(clamp(M[3], -1, 1))
  out.hipPitch = Math.atan2(-M[5], M[4])
  out.hipYaw = Math.atan2(-M[6], M[0])
  out.knee = knee
  out.anklePitch = anklePitch
  out.ankleRoll = ankleRoll
  for (const j of LEG_JOINTS) {
    const [lo, hi] = LEG_LIMITS[j]
    const v = clamp(out[j], lo, hi)
    if (v !== out[j]) {
      out[j] = v
      out.limited = true
    }
  }
  return out
}

/** Bone-local rotations of the leg chain: thigh (relative to pelvis), shin, foot. */
export function legRotations(q: LegAngles): [Mat3, Mat3, Mat3] {
  return [
    mul(mul(rotY(q.hipYaw), rotZ(q.hipRoll)), rotX(q.hipPitch)),
    rotX(q.knee),
    mul(rotX(q.anklePitch), rotZ(q.ankleRoll)),
  ]
}

export function fkLeg(p: LegParams, pelvisPos: Vec3, pelvisR: Mat3, side: 1 | -1, q: LegAngles) {
  const ho = apply(pelvisR, [side * p.hipW, 0, 0])
  const hip: Vec3 = [pelvisPos[0] + ho[0], pelvisPos[1] + ho[1], pelvisPos[2] + ho[2]]
  const [a, b, c] = legRotations(q)
  const R1 = mul(pelvisR, a)
  const knee = add(hip, apply(R1, [0, -p.L1, 0]))
  const R2 = mul(R1, b)
  const ankle = add(knee, apply(R2, [0, -p.L2, 0]))
  const R3 = mul(R2, c)
  const sole = add(ankle, apply(R3, [0, -p.ankleH, 0]))
  return { hip, knee, ankle, sole, soleR: R3 }
}

// ── Arm ───────────────────────────────────────────────────────────────────

export const ELBOW_MAX = 150 * deg

export interface ArmSolution {
  /** Upper arm rotation relative to the shoulder's parent frame. */
  R: Mat3
  /** Elbow hinge angle, <= 0 (forearm folds toward the upper arm's +Z). */
  elbow: number
  dist: number
  clamped: boolean
}

/**
 * Two-bone arm. `t` is the hand (wrist) target relative to the shoulder joint,
 * `pole` the direction the elbow should point, both in the parent frame.
 * Out-of-reach, zero-length or NaN targets come back finite: the hand stops
 * at the nearest reachable point, or the arm hangs at rest.
 */
/** Shortest shoulder-wrist distance the arm can fold to (the elbow limit). */
export function armMinReach(UA: number, FA: number) {
  return Math.max(Math.abs(UA - FA), Math.sqrt(UA * UA + FA * FA - 2 * UA * FA * Math.cos(Math.PI - ELBOW_MAX))) + 1e-6
}

export function solveArm(t: Vec3, pole: Vec3, UA: number, FA: number): ArmSolution {
  let d = Math.hypot(t[0], t[1], t[2])
  let u: Vec3
  let clamped = false
  if (!(d > 1e-9)) {
    u = [0, -1, 0]
    d = UA + FA
    clamped = true
  }
  else {
    u = [t[0] / d, t[1] / d, t[2] / d]
  }
  const dMin = armMinReach(UA, FA)
  const dMax = 0.9995 * (UA + FA)
  const dist = d
  if (d > dMax) { d = dMax; clamped = true }
  else if (d < dMin) { d = dMin; clamped = true }

  // Pole made perpendicular to the shoulder-hand line; any perpendicular if it is parallel.
  let pd = pole[0] * u[0] + pole[1] * u[1] + pole[2] * u[2]
  let n: Vec3 = [pole[0] - pd * u[0], pole[1] - pd * u[1], pole[2] - pd * u[2]]
  let nl = Math.hypot(n[0], n[1], n[2])
  if (!(nl > 1e-6)) {
    const alt: Vec3 = Math.abs(u[2]) < 0.9 ? [0, 0, -1] : [1, 0, 0]
    pd = alt[0] * u[0] + alt[1] * u[1] + alt[2] * u[2]
    n = [alt[0] - pd * u[0], alt[1] - pd * u[1], alt[2] - pd * u[2]]
    nl = Math.hypot(n[0], n[1], n[2])
  }
  n = [n[0] / nl, n[1] / nl, n[2] / nl]

  // Shoulder angle between the upper arm and the shoulder-hand line (law of cosines).
  const alpha = Math.acos(clamp((UA * UA + d * d - FA * FA) / (2 * UA * d), -1, 1))
  const interior = Math.acos(clamp((UA * UA + FA * FA - d * d) / (2 * UA * FA), -1, 1))
  const ca = Math.cos(alpha), sa = Math.sin(alpha)
  const a: Vec3 = [u[0] * ca + n[0] * sa, u[1] * ca + n[1] * sa, u[2] * ca + n[2] * sa]
  // Bone axes: +Y back up the arm, +Z the fold side (in the u-n plane, away from the pole), X = Y x Z.
  const y: Vec3 = [-a[0], -a[1], -a[2]]
  const z: Vec3 = [u[0] * sa - n[0] * ca, u[1] * sa - n[1] * ca, u[2] * sa - n[2] * ca]
  const x: Vec3 = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]]
  return {
    R: [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]],
    elbow: -(Math.PI - interior),
    dist,
    clamped,
  }
}

/** Wrist position relative to the shoulder for an arm pose (the FK the tests check IK against). */
export function fkArm(R: Mat3, elbow: number, UA: number, FA: number): { elbow: Vec3, wrist: Vec3 } {
  const e = apply(R, [0, -UA, 0])
  const f = apply(mul(R, rotX(elbow)), [0, -FA, 0])
  return { elbow: e, wrist: add(e, f) }
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
