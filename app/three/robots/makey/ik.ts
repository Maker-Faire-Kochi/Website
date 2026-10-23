import { apply, clamp, mat3, mul, rotX, rotY, rotZ, transpose, vec3, type Mat3, type Vec3 } from '../dog/kin'

/**
 * Closed-form 6-DOF leg IK for Makey (the same analytic method as the duck's,
 * Kajita et al.), plus arm and leg forward kinematics. Pure maths.
 *
 * Each leg is hip yaw (Y) -> hip roll (Z) -> hip pitch (X) -> KNEE (X) ->
 * ankle pitch (X) -> ankle roll (Z). Makey's knees bend FORWARD, like a
 * person's (knee > 0: the shin swings back relative to the thigh). The three
 * hip axes meet at one point and the two ankle axes at another, so:
 *   1. the hip seen from the ankle, in the SOLE frame, gives the knee (law of
 *      cosines) and the ankle roll and pitch (its direction);
 *   2. what is left of the sole's orientation belongs to the hip:
 *      R_hip = R_pelvis^T R_sole Rz(-ankleRoll) Rx(-(knee + anklePitch)),
 *      read off in yaw-roll-pitch order.
 * So a planted sole stays flat and unturned while the body sways above it.
 */

export const LEG = {
  hipW: 0.034,
  L1: 0.042,
  L2: 0.042,
  /** Ankle axis above the sole (Makey's feet are big and chunky). */
  ankleH: 0.03,
  /** Sole plate, from the ankle: half width, toe and heel. */
  footHalfW: 0.026,
  toe: 0.046,
  heel: -0.03,
}

const L1 = LEG.L1
const L2 = LEG.L2
const REACH = L1 + L2
export const D_MIN = 0.12 * REACH
export const D_MAX = 0.97 * REACH

export const LIMITS = {
  hipYaw: [-0.8, 0.8],
  hipRoll: [-0.5, 0.5],
  hipPitch: [-2.3, 1.2],
  knee: [0.02, 2.6],
  anklePitch: [-1.3, 1.0],
  ankleRoll: [-0.5, 0.5],
} as const
export const JOINTS = ['hipYaw', 'hipRoll', 'hipPitch', 'knee', 'anklePitch', 'ankleRoll'] as const

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
export const newSolution = (): LegSolution => ({ hipYaw: 0, hipRoll: 0, hipPitch: 0, knee: 0.5, anklePitch: 0, ankleRoll: 0, dist: 0, clamped: false, limited: false })

const V = vec3(), HO = vec3(), AO = vec3(), R3 = vec3()
const T0 = mat3(), T1 = mat3(), T2 = mat3(), T3 = mat3()

/** side +1 = left leg (+X). Pelvis and sole are world poses; the sole origin is the sole plate's ankle point on the ground. */
export function solveLeg(P: Vec3, PR: Mat3, side: number, sole: Vec3, soleR: Mat3, out: LegSolution = newSolution()): LegSolution {
  const ho = apply(PR, side * LEG.hipW, 0, 0, HO)
  const ao = apply(soleR, 0, LEG.ankleH, 0, AO)
  const dx = P[0] + ho[0] - sole[0] - ao[0]
  const dy = P[1] + ho[1] - sole[1] - ao[1]
  const dz = P[2] + ho[2] - sole[2] - ao[2]
  const r = apply(transpose(soleR, T0), dx, dy, dz, R3)
  const D = Math.hypot(r[0], r[1], r[2])
  out.dist = D
  out.clamped = false
  out.limited = false
  if (!(D > 1e-9)) {
    out.hipYaw = out.hipRoll = out.anklePitch = out.ankleRoll = 0
    out.hipPitch = -0.4
    out.knee = 0.8
    out.clamped = true
    return out
  }
  const Dc = clamp(D, D_MIN, D_MAX)
  if (Dc !== D) {
    out.clamped = true
    const k = Dc / D
    r[0] *= k; r[1] *= k; r[2] *= k
  }
  const cosK = clamp((Dc * Dc - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1)
  const knee = Math.acos(cosK)
  const ankleRoll = Math.atan2(r[0], r[1])
  const wy = Math.hypot(r[0], r[1])
  const vy = L1 * Math.cos(knee) + L2
  const vz = -L1 * Math.sin(knee)
  const anklePitch = Math.atan2(vz, vy) - Math.atan2(r[2], wy)
  const M = mul(mul(mul(transpose(PR, T0), soleR, T1), rotZ(-ankleRoll, T2), T3), rotX(-(knee + anklePitch), T2), T0)
  out.hipRoll = Math.asin(clamp(M[3], -1, 1))
  out.hipPitch = Math.atan2(-M[5], M[4])
  out.hipYaw = Math.atan2(-M[6], M[0])
  out.knee = knee
  out.anklePitch = anklePitch
  out.ankleRoll = ankleRoll
  for (const j of JOINTS) {
    const v = clamp(out[j], LIMITS[j][0], LIMITS[j][1])
    if (v !== out[j]) {
      out[j] = v
      out.limited = true
    }
  }
  return out
}

export interface LegFK { hip: Vec3, knee: Vec3, ankle: Vec3, sole: Vec3, soleR: Mat3 }

const FA = mat3(), FB = mat3(), FC = mat3()
/** Leg chain from the pelvis (world), angles in the order of JOINTS starting at q[o]. */
export function fkLeg(P: Vec3, PR: Mat3, side: number, q: ArrayLike<number>, o = 0): LegFK {
  const ho = apply(PR, side * LEG.hipW, 0, 0)
  const hip: Vec3 = [P[0] + ho[0], P[1] + ho[1], P[2] + ho[2]]
  const R1 = mul(mul(mul(PR, rotY(q[o]!, FA), FB), rotZ(q[o + 1]!, FA), FC), rotX(q[o + 2]!, FA))
  const t = apply(R1, 0, -L1, 0)
  const knee: Vec3 = [hip[0] + t[0], hip[1] + t[1], hip[2] + t[2]]
  const R2 = mul(R1, rotX(q[o + 3]!, FA))
  const s = apply(R2, 0, -L2, 0)
  const ankle: Vec3 = [knee[0] + s[0], knee[1] + s[1], knee[2] + s[2]]
  const R3m = mul(mul(R2, rotX(q[o + 4]!, FA), FB), rotZ(q[o + 5]!, FA))
  const f = apply(R3m, 0, -LEG.ankleH, 0)
  return { hip, knee, ankle, sole: [ankle[0] + f[0], ankle[1] + f[1], ankle[2] + f[2]], soleR: R3m }
}

/**
 * Arms: shoulder pitch (X) then roll (Z) -> elbow pitch (X) then roll (Z)
 * -> wrist roll (Z). q = [shPitch, shRoll, elX, elZ, wrist]. A positive
 * shoulder roll raises the LEFT arm out to the side (right arm: negative).
 */
export const ARM = {
  shoulderX: 0.079,
  shoulderY: 0.104,
  upper: 0.044,
  fore: 0.04,
  hand: 0.026,
}

/** Arm points in the PELVIS frame: elbow, wrist, hand centre. */
export function fkArm(side: number, q: ArrayLike<number>, o: number, out: { elbow: Vec3, wrist: Vec3, hand: Vec3 }) {
  const R1 = mul(rotX(q[o]!, FA), rotZ(q[o + 1]!, FB), FC)
  const e = apply(R1, 0, -ARM.upper, 0, out.elbow)
  e[0] += side * ARM.shoulderX; e[1] += ARM.shoulderY
  const R2 = mul(mul(R1, rotX(q[o + 2]!, FA), FB), rotZ(q[o + 3]!, FA))
  const w = apply(R2, 0, -ARM.fore, 0, out.wrist)
  w[0] += e[0]; w[1] += e[1]; w[2] += e[2]
  const R3m = mul(R2, rotZ(q[o + 4]!, FB), FC)
  const h = apply(R3m, 0, -ARM.hand * 0.6, 0, out.hand)
  h[0] += w[0]; h[1] += w[1]; h[2] += w[2]
  return out
}
