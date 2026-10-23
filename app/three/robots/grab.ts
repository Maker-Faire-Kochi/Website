/**
 * The mouse grab, shared by every robot: a spring-damper between the point
 * where the robot was picked (carried with its body) and the pointer's
 * target. Each robot turns the resulting FORCE into motion through its own
 * physics -- the balancer's pendulum, the duck's stagger/fall, the rover's
 * chassis -- so a drag is felt, not teleported.
 *
 * Pure maths, no three.js, no allocation. The damper acts on the grab
 * point's own velocity, and the force is zero when the point sits on the
 * target at rest: holding still and letting go adds no energy.
 */
export const GRAB = {
  /** Spring stiffness, N/m. */
  k: 60,
  /** Damping on the grab point's velocity, N s/m. */
  c: 5,
  /** Hand strength: the pull never exceeds this, N. */
  maxForce: 14,
  /** The target is lifted this far above the ground point under the pointer, m. */
  lift: 0.05,
}

export interface Force3 { x: number, y: number, z: number }

/**
 * F = k (target - p) - c v, clamped to GRAB.maxForce. p, v: grab point
 * position and velocity (world); t: target. Writes into out.
 */
export function grabForce(
  px: number, py: number, pz: number,
  vx: number, vy: number, vz: number,
  tx: number, ty: number, tz: number,
  out: Force3,
) {
  let fx = GRAB.k * (tx - px) - GRAB.c * vx
  let fy = GRAB.k * (ty - py) - GRAB.c * vy
  let fz = GRAB.k * (tz - pz) - GRAB.c * vz
  const f = Math.hypot(fx, fy, fz)
  if (f > GRAB.maxForce) {
    const s = GRAB.maxForce / f
    fx *= s
    fy *= s
    fz *= s
  }
  out.x = fx
  out.y = fy
  out.z = fz
  return out
}
