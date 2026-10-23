import { apply, clamp, mat3, mul, rotX, rotZ, transpose, vec3, type Mat3, type Vec3 } from './kin'

/**
 * Closed-form 3-DOF leg IK for the robot dog, plus the matching FK. Pure
 * maths, no three.js.
 *
 * The leg follows the Unitree Go-class layout (proportions from the Go2:
 * ~0.70 x 0.31 x 0.40 m standing, thigh and calf of equal length; drawn
 * here at 0.6 scale so it stands beside the ducks):
 *   hip ABDUCTION about the body's long axis (Z), at the body corner;
 *   the thigh hangs in a plane offset `d` OUTBOARD of that axis;
 *   hip FLEXION about the leg's own X, then the KNEE about X.
 * All four knees point BACKWARD (knee < 0), as on the real machine: the
 * thigh runs down and back from the hip, the calf down and forward to the
 * foot, which lands under the hip.
 *
 * Solution (body frame, hip abduction point at the origin, p = foot pad
 * centre):
 *   1. Abduction. Looking along Z, the foot sits in the leg plane at
 *      (side d, -h) rotated by q1, so h = sqrt(px^2 + py^2 - d^2) and
 *      q1 = atan2(py, px) - atan2(-h, side d).
 *   2. In the leg plane the foot is at (forward pz, down h): a planar
 *      two-link problem. q3 from the law of cosines, q2 = phi - beta.
 * The hip-foot distance is clamped to [D_MIN, D_MAX], so nothing goes NaN at
 * full stretch or full fold; a clamped or limited solution is flagged.
 */

export const DOG = {
  /** Abduction axis: lateral (+ left) and fore/aft offset of each hip from the body origin. */
  hipX: 0.03,
  hipZ: 0.116,
  /** Thigh plane offset outboard of the abduction axis. */
  d: 0.054,
  L1: 0.128,
  L2: 0.128,
  /** Foot pad radius: the pad centre is this far above the ground contact. */
  footR: 0.014,
}

const L1 = DOG.L1
const L2 = DOG.L2
const REACH = L1 + L2
export const D_MIN = 0.16 * REACH
export const D_MAX = 0.97 * REACH

export const LIMITS = {
  abd: [-0.8, 0.8],
  hip: [-1.6, 2.7],
  knee: [-2.72, -0.5],
} as const

/** Leg order: 0 front left, 1 front right, 2 hind left, 3 hind right. */
export const legSide = (i: number) => (i % 2 === 0 ? 1 : -1)
export const legFore = (i: number) => (i < 2 ? 1 : -1)

export interface LegQ {
  abd: number
  hip: number
  knee: number
  /** Hip-foot distance in the leg plane before clamping. */
  dist: number
  clamped: boolean
  limited: boolean
}

export const newLegQ = (): LegQ => ({ abd: 0, hip: 0, knee: -1, dist: 0, clamped: false, limited: false })

const P = vec3(), T = mat3()

/**
 * Solve leg i for a foot pad centre at `foot` (world), body at `body` (world)
 * with orientation R.
 */
export function solveLeg(body: Vec3, R: Mat3, i: number, foot: Vec3, out: LegQ = newLegQ()): LegQ {
  const side = legSide(i)
  // Foot relative to the hip abduction point, in the body frame.
  const wx = foot[0] - body[0], wy = foot[1] - body[1], wz = foot[2] - body[2]
  const p = apply(transpose(R, T), wx, wy, wz, P)
  const px = p[0] - side * DOG.hipX, py = p[1], pz = p[2] - legFore(i) * DOG.hipZ
  out.clamped = false
  out.limited = false
  if (!Number.isFinite(px + py + pz)) {
    out.abd = 0
    out.hip = 0.6
    out.knee = -1.2
    out.dist = 0
    out.clamped = true
    return out
  }
  let h2 = px * px + py * py - DOG.d * DOG.d
  if (h2 < 1e-8) {
    h2 = 1e-8
    out.clamped = true
  }
  const h = Math.sqrt(h2)
  out.abd = Math.atan2(py, px) - Math.atan2(-h, side * DOG.d)
  // Wrap into (-pi, pi]: the leg hangs below its abduction axis.
  out.abd = Math.atan2(Math.sin(out.abd), Math.cos(out.abd))
  let f = pz, hh = h
  const D = Math.hypot(f, hh)
  out.dist = D
  if (D > D_MAX || D < D_MIN) {
    const k = clamp(D, D_MIN, D_MAX) / Math.max(D, 1e-9)
    f *= k
    hh *= k
    out.clamped = true
  }
  const Dc = Math.hypot(f, hh)
  const cosK = clamp((Dc * Dc - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1)
  const knee = -Math.acos(cosK)
  const phi = Math.atan2(-f, hh)
  const beta = Math.atan2(L2 * Math.sin(knee), L1 + L2 * Math.cos(knee))
  out.hip = phi - beta
  out.knee = knee
  const lim = (v: number, r: readonly [number, number]) => {
    const c = clamp(v, r[0], r[1])
    if (c !== v) out.limited = true
    return c
  }
  out.abd = lim(out.abd, LIMITS.abd)
  out.hip = lim(out.hip, LIMITS.hip)
  out.knee = lim(out.knee, LIMITS.knee)
  return out
}

export interface LegFK {
  hip: Vec3
  thigh: Vec3
  knee: Vec3
  foot: Vec3
}

const FA = mat3(), FB = mat3(), FC = mat3(), FV = vec3()

/** Forward kinematics of leg i (world points), for tests, contact and the scripted falls. */
export function fkLeg(body: Vec3, R: Mat3, i: number, abd: number, hip: number, knee: number, out?: LegFK): LegFK {
  const o = out ?? { hip: vec3(), thigh: vec3(), knee: vec3(), foot: vec3() }
  fkLocal(i, abd, hip, knee, o)
  for (const k of ['hip', 'thigh', 'knee', 'foot'] as const) {
    const v = o[k]
    apply(R, v[0], v[1], v[2], FV)
    v[0] = body[0] + FV[0]
    v[1] = body[1] + FV[1]
    v[2] = body[2] + FV[2]
  }
  return o
}

/** The same chain in the BODY frame (no body pose). */
export function fkLocal(i: number, abd: number, hip: number, knee: number, o: LegFK) {
  const side = legSide(i)
  const hx = side * DOG.hipX, hz = legFore(i) * DOG.hipZ
  o.hip[0] = hx; o.hip[1] = 0; o.hip[2] = hz
  const R1 = rotZ(abd, FA)
  apply(R1, side * DOG.d, 0, 0, FV)
  o.thigh[0] = hx + FV[0]; o.thigh[1] = FV[1]; o.thigh[2] = hz + FV[2]
  const R2 = mul(R1, rotX(hip, FB), FC)
  apply(R2, 0, -L1, 0, FV)
  o.knee[0] = o.thigh[0] + FV[0]; o.knee[1] = o.thigh[1] + FV[1]; o.knee[2] = o.thigh[2] + FV[2]
  const R3 = mul(R2, rotX(knee, FA), FB)
  apply(R3, 0, -L2, 0, FV)
  o.foot[0] = o.knee[0] + FV[0]; o.foot[1] = o.knee[1] + FV[1]; o.foot[2] = o.knee[2] + FV[2]
  return o
}
