/**
 * Closed-form 6-DOF leg IK for the duck biped (Kajita et al., "Introduction to
 * Humanoid Robotics", analytic leg IK), plus the matching forward kinematics.
 *
 * Pure maths, no three.js: the gait, the renderer and the tsx tests all solve
 * the same chain with the same numbers.
 *
 * Frame conventions (match the scene): +Y up, a figure faces +Z at yaw 0, +X
 * is its LEFT. Rotations are right-handed: Ry(yaw) turns +Z toward +X,
 * Rx(pitch > 0) tips +Y toward +Z (forward), Rz(roll > 0) tips +Y toward -X.
 *
 * Each leg is hip yaw (Y) -> hip roll (Z) -> hip pitch (X) -> knee (X) ->
 * ankle pitch (X) -> ankle roll (Z). The three hip axes meet at one point and
 * the two ankle axes meet at another, which is what makes the chain solvable
 * in closed form:
 *   1. Express the hip, seen from the ankle, in the SOLE frame. Its length
 *      gives the knee (law of cosines); its direction gives ankle roll and
 *      ankle pitch.
 *   2. Whatever rotation is left over belongs to the hip:
 *      R_hip = R_pelvis^T * R_sole * Rz(-ankleRoll) * Rx(-(knee + anklePitch)),
 *      decomposed in the chain's own yaw-roll-pitch order.
 * So the sole's orientation is exact for ANY pelvis pitch/roll/yaw inside the
 * joint limits -- which is what keeps a stance foot flat and unturned while the
 * body waddles above it.
 *
 * The knee bends BACKWARD (knee < 0), bird-fashion: thigh back from the hip,
 * shin forward to the ankle.
 */

export type Vec3 = [number, number, number]
/** 3x3 rotation, row-major. */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

export const LEG = {
  /** Hip joint offset from the pelvis origin along the pelvis X axis (left = +). */
  hipW: 0.045,
  /** Thigh, hip axis to knee axis. */
  L1: 0.07,
  /** Shin, knee axis to ankle axis. */
  L2: 0.07,
  /** Ankle axis height above the sole. */
  ankleH: 0.024,
}

const L1 = LEG.L1
const L2 = LEG.L2
const REACH = L1 + L2
/** A1.1 §4: the hip-ankle distance is clamped to this band, so nothing goes NaN at full stretch. */
export const D_MIN = Math.abs(L1 - L2) + 0.05 * REACH
export const D_MAX = 0.97 * REACH

const deg = Math.PI / 180
/** Joint limits in radians. Yaw/roll limits are the plan's (A1.3); pitch limits are the servo brackets'. */
export const LIMITS = {
  hipYaw: [-45 * deg, 45 * deg],
  hipRoll: [-25 * deg, 25 * deg],
  hipPitch: [-80 * deg, 80 * deg],
  knee: [-170 * deg, -10 * deg],
  anklePitch: [-80 * deg, 80 * deg],
  ankleRoll: [-25 * deg, 25 * deg],
} as const

export interface LegAngles {
  hipYaw: number
  hipRoll: number
  hipPitch: number
  knee: number
  anklePitch: number
  ankleRoll: number
}

export interface LegSolution extends LegAngles {
  /** Hip-ankle distance before clamping. */
  dist: number
  /** The target was outside [D_MIN, D_MAX] (or degenerate) and the leg was solved for the nearest reachable point. */
  clamped: boolean
  /** A joint hit its limit and was held there; the sole pose is then not exact. */
  limited: boolean
}

export const JOINTS = ['hipYaw', 'hipRoll', 'hipPitch', 'knee', 'anklePitch', 'ankleRoll'] as const

// ── Small rotation helpers ────────────────────────────────────────────────

// Every helper takes an optional `out`: the renderer poses two legs per robot
// per frame, so the per-frame path writes into module scratch instead of
// allocating ~20 small arrays a leg. Results are bit-identical either way
// (same expressions, same order); `out` may alias an input.

const mat3 = (): Mat3 => [0, 0, 0, 0, 0, 0, 0, 0, 0]
const vec3 = (): Vec3 => [0, 0, 0]

function set9(o: Mat3, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number): Mat3 {
  o[0] = a; o[1] = b; o[2] = c; o[3] = d; o[4] = e; o[5] = f; o[6] = g; o[7] = h; o[8] = i
  return o
}

export function rotX(a: number, out: Mat3 = mat3()): Mat3 {
  const c = Math.cos(a), s = Math.sin(a)
  return set9(out, 1, 0, 0, 0, c, -s, 0, s, c)
}
export function rotY(a: number, out: Mat3 = mat3()): Mat3 {
  const c = Math.cos(a), s = Math.sin(a)
  return set9(out, c, 0, s, 0, 1, 0, -s, 0, c)
}
export function rotZ(a: number, out: Mat3 = mat3()): Mat3 {
  const c = Math.cos(a), s = Math.sin(a)
  return set9(out, c, -s, 0, s, c, 0, 0, 0, 1)
}
export function mul(a: Mat3, b: Mat3, out: Mat3 = mat3()): Mat3 {
  return set9(out,
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  )
}
export function transpose(a: Mat3, out: Mat3 = mat3()): Mat3 {
  return set9(out, a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8])
}
export function apply(m: Mat3, v: Vec3, out: Vec3 = vec3()): Vec3 {
  const x = m[0] * v[0] + m[1] * v[1] + m[2] * v[2]
  const y = m[3] * v[0] + m[4] * v[1] + m[5] * v[2]
  const z = m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  out[0] = x; out[1] = y; out[2] = z
  return out
}
const PR_A = mat3(), PR_B = mat3(), PR_C = mat3()
/** Pelvis orientation: yaw, then pitch about the yawed X, then roll about the pitched Z (three.js Euler 'YXZ'). */
export function pelvisRotation(yaw: number, pitch: number, roll: number, out: Mat3 = mat3()): Mat3 {
  return mul(mul(rotY(yaw, PR_A), rotX(pitch, PR_B), PR_C), rotZ(roll, PR_A), out)
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

// ── Inverse kinematics ────────────────────────────────────────────────────

// solveLeg's scratch (it never re-enters, and returns only `out`).
const V0 = vec3(), HO = vec3(), AO = vec3(), D3 = vec3(), R3 = vec3()
const T0 = mat3(), T1 = mat3(), T2 = mat3(), T3 = mat3()

/**
 * Solve one leg. `side` is +1 for the left leg (+X), -1 for the right.
 * Pelvis and sole are full world poses; the sole frame's origin is the
 * centre of the sole, its +Y the sole normal.
 */
export function solveLeg(
  pelvisPos: Vec3, pelvisR: Mat3, side: 1 | -1,
  solePos: Vec3, soleR: Mat3,
  out: LegSolution = { hipYaw: 0, hipRoll: 0, hipPitch: 0, knee: 0, anklePitch: 0, ankleRoll: 0, dist: 0, clamped: false, limited: false },
): LegSolution {
  V0[0] = side * LEG.hipW; V0[1] = 0; V0[2] = 0
  const ho = apply(pelvisR, V0, HO)
  V0[0] = 0; V0[1] = LEG.ankleH; V0[2] = 0
  const ao = apply(soleR, V0, AO)
  // Hip relative to ankle, world frame, then sole frame.
  const d = D3
  d[0] = pelvisPos[0] + ho[0] - solePos[0] - ao[0]
  d[1] = pelvisPos[1] + ho[1] - solePos[1] - ao[1]
  d[2] = pelvisPos[2] + ho[2] - solePos[2] - ao[2]
  const r = apply(transpose(soleR, T0), d, R3)
  const D = Math.hypot(r[0], r[1], r[2])
  out.dist = D
  out.clamped = false
  out.limited = false
  if (!(D > 1e-9)) {
    // Degenerate (zero-length or NaN) target: no direction to solve for. Fall back to the rest pose.
    out.hipYaw = out.hipRoll = out.hipPitch = out.anklePitch = out.ankleRoll = 0
    out.knee = LIMITS.knee[1]
    out.clamped = true
    return out
  }
  let Dc = D
  if (D > D_MAX) Dc = D_MAX
  else if (D < D_MIN) Dc = D_MIN
  if (Dc !== D) {
    out.clamped = true
    const k = Dc / D
    r[0] = r[0] * k; r[1] = r[1] * k; r[2] = r[2] * k
  }

  // Knee from the law of cosines: Dc^2 = L1^2 + L2^2 + 2 L1 L2 cos(knee).
  const cosK = clamp((Dc * Dc - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1)
  const knee = -Math.acos(cosK)

  // Ankle roll and pitch from the direction of r (see the derivation above):
  // r = Rz(-roll) Rx(-pitch) v, with v = hip seen from the ankle in the shin's frame.
  const ankleRoll = Math.atan2(r[0], r[1])
  const wy = Math.hypot(r[0], r[1])
  const vy = L1 * Math.cos(knee) + L2
  const vz = -L1 * Math.sin(knee)
  const anklePitch = Math.atan2(vz, vy) - Math.atan2(r[2], wy)

  // Hip: what remains of the sole's orientation once the lower joints are undone.
  const M = mul(mul(mul(transpose(pelvisR, T0), soleR, T1), rotZ(-ankleRoll, T2), T3), rotX(-(knee + anklePitch), T2), T0)
  // M = Ry(yaw) Rz(roll) Rx(pitch): M[3] = sin(roll), M[4] = cos(roll)cos(pitch), M[5] = -cos(roll)sin(pitch),
  // M[0] = cos(yaw)cos(roll), M[6] = -sin(yaw)cos(roll).
  const hipRoll = Math.asin(clamp(M[3], -1, 1))
  const hipPitch = Math.atan2(-M[5], M[4])
  const hipYaw = Math.atan2(-M[6], M[0])

  out.hipYaw = hipYaw
  out.hipRoll = hipRoll
  out.hipPitch = hipPitch
  out.knee = knee
  out.anklePitch = anklePitch
  out.ankleRoll = ankleRoll
  for (const j of JOINTS) {
    const [lo, hi] = LIMITS[j]
    const v = clamp(out[j], lo, hi)
    if (v !== out[j]) {
      out[j] = v
      out.limited = true
    }
  }
  return out
}

// ── Forward kinematics ────────────────────────────────────────────────────

export interface LegFK {
  hip: Vec3
  knee: Vec3
  ankle: Vec3
  sole: Vec3
  /** Sole orientation; column 1 (entries 1, 4, 7) is the sole normal. */
  soleR: Mat3
}

export function fkLeg(pelvisPos: Vec3, pelvisR: Mat3, side: 1 | -1, q: LegAngles): LegFK {
  const ho = apply(pelvisR, [side * LEG.hipW, 0, 0])
  const hip: Vec3 = [pelvisPos[0] + ho[0], pelvisPos[1] + ho[1], pelvisPos[2] + ho[2]]
  const R1 = mul(mul(mul(pelvisR, rotY(q.hipYaw)), rotZ(q.hipRoll)), rotX(q.hipPitch))
  const t = apply(R1, [0, -L1, 0])
  const knee: Vec3 = [hip[0] + t[0], hip[1] + t[1], hip[2] + t[2]]
  const R2 = mul(R1, rotX(q.knee))
  const s = apply(R2, [0, -L2, 0])
  const ankle: Vec3 = [knee[0] + s[0], knee[1] + s[1], knee[2] + s[2]]
  const R3 = mul(mul(R2, rotX(q.anklePitch)), rotZ(q.ankleRoll))
  const f = apply(R3, [0, -LEG.ankleH, 0])
  return { hip, knee, ankle, sole: [ankle[0] + f[0], ankle[1] + f[1], ankle[2] + f[2]], soleR: R3 }
}
