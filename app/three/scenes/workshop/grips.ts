/**
 * Where a hand holds each tool, in the tool's own frame (layout.ts), and the
 * pose maths to carry those points into the world. Pure numbers, no three.js,
 * so the carpenter's director and the tests share them.
 *
 * A grip is the PALM CENTRE plus the surface normal there (out of the tool,
 * toward the palm), the handle's AXIS, the KIND of hold and the handle's
 * radius -- the people library's grip API. For a wrap the palm centre is the
 * handle centre + normal x (radius + half a hand, 0.011 x stature): the hand
 * closes round the handle instead of sinking into it.
 */

import { CHISEL, MALLET, SAW } from './layout'

export type V3 = [number, number, number]
export type GripKind = 'wrap' | 'pinch' | 'flat'
export interface Grip { p: V3, n: V3, axis?: V3, kind: GripKind, radius: number }

/** Half the hand's thickness for the carpenter (0.011 x stature, 1.82 m). */
const PALM = 0.02

const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** A grip from the point on the handle's surface under the palm, its normal and axis. */
function grip(surface: V3, n: V3, kind: GripKind, radius: number, axis?: V3): Grip {
  const u = unit(n)
  return { p: [surface[0] + u[0] * PALM, surface[1] + u[1] * PALM, surface[2] + u[2] * PALM], n: u, axis: axis && unit(axis), kind, radius }
}

export const GRIPS = {
  /**
   * Saw: a fist round the handle's back bar. The palm lies against the side of
   * the handle the carpenter stands on (+z), the fingers run forward across the
   * bar along the blade and curl round it -- the forearm in line with the push.
   */
  saw: grip([-(SAW.teeth + 0.1175), 0.068, 0.011], [0, 0, 1], 'wrap', 0.011, [0.105, -0.994, 0]),
  /** Saw by the blade near the handle: a pinch on the flat. */
  sawBlade: grip([-(SAW.teeth - 0.07), 0.07, 0.001], [0, 0, 1], 'pinch', 0.002),
  /** Plane: a fist round the tote from the carpenter's side; an open hand on the front knob. */
  tote: grip([-0.096, 0.07, 0.01], [0, 0, 1], 'wrap', 0.012, [-0.423, -0.906, 0]),
  knob: grip([0.092, 0.06, 0], [0, 1, 0], 'flat', 0.016, [0, 0, 1]),
  /**
   * Chisel: a fist round the handle, thumb up, the palm on its front-left
   * (the drawn world is mirrored: local +x is the carpenter's left), so the
   * fingers wrap round it in line with a forearm reaching from the front.
   */
  chisel: grip([0.014 * 0.87, CHISEL.len - 0.065, 0.014 * 0.5], [0.87, 0, 0.5], 'wrap', 0.014, [0, 1, 0]),
  /**
   * Mallet: a hammer grip round the handle near its end, the palm against
   * the handle's side (local +z, which the half-turned working mallet puts on
   * the far side), so the fingers wrap round it square to the swing plane and
   * the wrist bends with the swing instead of across it.
   */
  mallet: grip([-0.05, 0, 0.013], [0, 0, 1], 'wrap', 0.012, [1, 0, 0]),
} satisfies Record<string, Grip>
export type GripKey = keyof typeof GRIPS

/** Rotation matrix (row-major) of a three.js Euler XYZ: R = Rx(a) Ry(b) Rz(c). */
export function eulerXYZ(a: number, b: number, c: number, out: number[] = new Array(9)) {
  const ca = Math.cos(a), sa = Math.sin(a)
  const cb = Math.cos(b), sb = Math.sin(b)
  const cc = Math.cos(c), sc = Math.sin(c)
  out[0] = cb * cc
  out[1] = -cb * sc
  out[2] = sb
  out[3] = ca * sc + sa * sb * cc
  out[4] = ca * cc - sa * sb * sc
  out[5] = -sa * cb
  out[6] = sa * sc - ca * sb * cc
  out[7] = sa * cc + ca * sb * sc
  out[8] = ca * cb
  return out
}

const R = new Array<number>(9)

/**
 * A grip of a tool at `pose` ([x, y, z, rx, ry, rz]) in the world: palm point,
 * normal and (when given) handle axis. `mirror` = -1 reflects the result in
 * x: the sim's tools live in a frame the scene draws mirrored (index.ts).
 */
export function gripWorld(g: Grip, pose: ArrayLike<number>, p: { x: number, y: number, z: number }, n?: { x: number, y: number, z: number }, axis?: { x: number, y: number, z: number }, mirror = 1) {
  eulerXYZ(pose[3]!, pose[4]!, pose[5]!, R)
  const [x, y, z] = g.p
  p.x = (pose[0]! + R[0]! * x + R[1]! * y + R[2]! * z) * mirror
  p.y = pose[1]! + R[3]! * x + R[4]! * y + R[5]! * z
  p.z = pose[2]! + R[6]! * x + R[7]! * y + R[8]! * z
  if (n) {
    const [a, b, c] = g.n
    n.x = (R[0]! * a + R[1]! * b + R[2]! * c) * mirror
    n.y = R[3]! * a + R[4]! * b + R[5]! * c
    n.z = R[6]! * a + R[7]! * b + R[8]! * c
  }
  if (axis && g.axis) {
    const [a, b, c] = g.axis
    axis.x = (R[0]! * a + R[1]! * b + R[2]! * c) * mirror
    axis.y = R[3]! * a + R[4]! * b + R[5]! * c
    axis.z = R[6]! * a + R[7]! * b + R[8]! * c
  }
  return p
}
