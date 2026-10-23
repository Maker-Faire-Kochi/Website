/**
 * Small rotation maths for the dog and Makey (pure, no three.js), so the
 * gaits, the IK, the scripted falls and the tsx tests all share one set of
 * numbers.
 *
 * Frames match the scene: +Y up, a figure faces +Z at yaw 0, +X is its LEFT.
 * Rx(a > 0) tips +Y toward +Z (nose down), Ry(a > 0) turns +Z toward +X,
 * Rz(a > 0) tips +Y toward -X. A body's orientation is yaw, then pitch, then
 * roll (three.js Euler 'YXZ').
 *
 * Every helper takes an optional `out` so per-frame paths do not allocate.
 */

export type Vec3 = [number, number, number]
/** 3x3 rotation, row-major. */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

export const mat3 = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1]
export const vec3 = (): Vec3 => [0, 0, 0]

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
export function apply(m: Mat3, x: number, y: number, z: number, out: Vec3 = vec3()): Vec3 {
  out[0] = m[0] * x + m[1] * y + m[2] * z
  out[1] = m[3] * x + m[4] * y + m[5] * z
  out[2] = m[6] * x + m[7] * y + m[8] * z
  return out
}

const BR_A = mat3(), BR_B = mat3(), BR_C = mat3()
/** Body orientation: yaw, then pitch about the yawed X, then roll about the pitched Z (Euler 'YXZ'). */
export function bodyRotation(yaw: number, pitch: number, roll: number, out: Mat3 = mat3()): Mat3 {
  return mul(mul(rotY(yaw, BR_A), rotX(pitch, BR_B), BR_C), rotZ(roll, BR_A), out)
}

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)
export const smooth = (t: number) => t * t * (3 - 2 * t)
export const approach = (x: number, target: number, maxDelta: number) =>
  x < target ? Math.min(target, x + maxDelta) : Math.max(target, x - maxDelta)

/** Second-order spring, semi-implicit Euler at the fixed step. zeta = 1 is critically damped. */
export class Spring {
  x = 0
  v = 0
  step(target: number, omega: number, zeta: number, dt: number) {
    this.v += (omega * omega * (target - this.x) - 2 * zeta * omega * this.v) * dt
    this.x += this.v * dt
  }
  /** Hard stop at +-lim: the joint cannot pass it and does not bounce off it. */
  limit(lim: number) {
    if (this.x > lim) { this.x = lim; if (this.v > 0) this.v = 0 }
    else if (this.x < -lim) { this.x = -lim; if (this.v < 0) this.v = 0 }
  }
}
