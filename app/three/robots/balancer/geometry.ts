/**
 * The wheel-legged balancer's dimensions, shared by its simulation
 * (dynamics.ts) and its drawing (model.ts) so the two can never disagree.
 * Pure constants, metres.
 *
 * Layout (body frame: origin on the wheel axle, +Y up the legs, +Z forward
 * along the heading, +X to the robot's left): two large spoked wheels on
 * one axle line; from each wheel hub a two-link leg (shin from the hub to
 * the knee, thigh from the knee to the hip) rises to the hip axis, where a
 * compact rounded body pod sits; a small pan-tilt sensor head stands on the
 * pod. The leg length L is the straight distance from the axle up to the
 * hip axis -- crouch, stand, stand tall, or extend fast to jump.
 */
export const GEO = {
  /** Wheel (tyre) radius and width. */
  wheelR: 0.055,
  wheelW: 0.014,
  /** Wheel centre-plane offset from the mid-plane (half track). */
  wheelX: 0.078,
  /** Leg plane offset from the mid-plane (inboard of the wheels). */
  legX: 0.06,
  /** Link lengths: hip to knee, knee to wheel hub. */
  thigh: 0.085,
  shin: 0.085,
  /** Knees point backward (-Z) -- like a bird's, and like the reference robot. */
  kneeBack: true,
  /** Leg length limits and set points (axle to hip axis). */
  legMin: 0.07,
  legCrouch: 0.09,
  legStand: 0.125,
  legTall: 0.15,
  legMax: 0.165,
  /** Body pod, relative to the hip axis: half width, front/back extent, bottom/top. */
  podHalfW: 0.058,
  podFront: 0.05,
  podBack: -0.045,
  podBottom: -0.028,
  podTop: 0.042,
  /** Sensor head: yaw axis on the pod top, pitch axis above it, eyes above the yaw base. */
  headBase: 0.042,
  pitchAxis: 0.024,
  eyeUp: 0.042 + 0.024 + 0.006,
  /** Head extents for contact (around the pitch axis): half width, forward reach. */
  headHalfW: 0.04,
  headFront: 0.028,
} as const

/**
 * Knee and hip angles that put the hip axis `len` straight above the wheel
 * hub (2-link planar IK). Angles are about the body X axis, measured from
 * the body's +Y: shinAngle tilts the shin (hub -> knee), thighAngle the
 * thigh (knee -> hip). Writes [shinAngle, kneeAngle] into out, where
 * kneeAngle is the thigh's rotation relative to the shin.
 */
export function legAngles(len: number, out: [number, number]) {
  const a = GEO.shin, b = GEO.thigh
  const L = Math.min(a + b - 1e-6, Math.max(Math.abs(a - b) + 1e-6, len))
  // Angle at the hub between the hub->hip line (straight up) and the shin.
  const cosA = (a * a + L * L - b * b) / (2 * a * L)
  const alpha = Math.acos(Math.max(-1, Math.min(1, cosA)))
  // Interior angle at the knee.
  const cosK = (a * a + b * b - L * L) / (2 * a * b)
  const knee = Math.acos(Math.max(-1, Math.min(1, cosK)))
  // Knee behind the hub-hip line: the shin leans back (rotation.x < 0 tips +Y toward -Z).
  const s = GEO.kneeBack ? -1 : 1
  out[0] = s * alpha
  out[1] = -s * (Math.PI - knee)
  return out
}
