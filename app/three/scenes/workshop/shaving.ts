import { PLANE } from './layout'

/**
 * The plane's shaving: a thin ribbon that leaves the throat going up and rolls
 * forward into a coil. A shaving is wood, not a machine member, so it is
 * allowed to curve.
 *
 * The coil is an Archimedean spiral r = r0 + c*phi, measured from its free end
 * (the first wood cut, now innermost). As the plane advances, new ribbon is
 * pushed out at the throat, the arc length L grows, and the whole coil rolls
 * about the fixed exit point -- which is what a real shaving does. The arc
 * length of the spiral is taken as integral(r dphi) = r0*phi + c*phi^2/2
 * (c << r), which inverts in closed form.
 */
export const SHAVING = {
  r0: 0.01,
  c: 0.0009,
  width: 0.022,
  /**
   * Exit direction at the throat: up and BACK, along the iron bedded at 45
   * degrees -- then the curl carries it forward over the throat. Leaving
   * forward would roll the coil down into the plane's body.
   */
  exit: 2.36,
  segments: 48,
}

export interface ShavingFrame {
  /** Centroid of the centre line in the plane's local frame (x, y). */
  cx: number
  cy: number
  /** Furthest centre-line point from the centroid: the coil's bounding radius. */
  radius: number
}

const phiAt = (s: number) => (-SHAVING.r0 + Math.sqrt(SHAVING.r0 * SHAVING.r0 + 2 * SHAVING.c * s)) / SHAVING.c

/**
 * Centre line of a shaving of length L, as (segments + 1) x,y pairs from the
 * throat (index 0) to the free end, RELATIVE TO THE CENTROID -- so a detached
 * shaving can spin about its own middle. Returns the centroid in the plane's
 * frame and the bounding radius.
 */
export function shavingCurve(L: number, out: Float32Array, n = SHAVING.segments): ShavingFrame {
  const { r0, c, exit } = SHAVING
  const len = Math.max(L, 1e-5)
  const Phi = phiAt(len)
  // Base tangent, pointing from the throat toward the free end (-dp/dphi at Phi).
  const rB = r0 + c * Phi
  const tx = -(c * Math.cos(Phi) - rB * Math.sin(Phi))
  const ty = -(c * Math.sin(Phi) + rB * Math.cos(Phi))
  const rot = exit - Math.atan2(ty, tx)
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const bx = rB * Math.cos(Phi)
  const by = rB * Math.sin(Phi)
  let sx = 0
  let sy = 0
  for (let k = 0; k <= n; k++) {
    const phi = phiAt(len * (1 - k / n))
    const r = r0 + c * phi
    const px = r * Math.cos(phi) - bx
    const py = r * Math.sin(phi) - by
    const x = PLANE.throat[0] + px * cr - py * sr
    const y = PLANE.throat[1] + px * sr + py * cr
    out[k * 2] = x
    out[k * 2 + 1] = y
    sx += x
    sy += y
  }
  const cx = sx / (n + 1)
  const cy = sy / (n + 1)
  let radius = 0
  for (let k = 0; k <= n; k++) {
    out[k * 2] = out[k * 2]! - cx
    out[k * 2 + 1] = out[k * 2 + 1]! - cy
    radius = Math.max(radius, Math.hypot(out[k * 2]!, out[k * 2 + 1]!))
  }
  return { cx, cy, radius }
}
