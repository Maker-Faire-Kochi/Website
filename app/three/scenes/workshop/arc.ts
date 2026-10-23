import { smoother, type Pose } from './layout'

/**
 * How a tool travels between its rest and its work: carried BY A HAND. The
 * point that travels in an eased arc is the tool's grip (where the hand is),
 * lifted over everything between; the tool turns about that point with a
 * shortest-path (slerp) rotation. Interpolating the pose's origin and Euler
 * angles instead would swing the handle -- and the hand on it -- through a
 * wide loop whenever the tool turns over, as the saw does coming off the
 * bench. Pure maths; the angles come back continuous with the endpoints'
 * (no 2 pi jumps for the renderer's step-to-step interpolation) and the arc
 * ends exactly on its target pose.
 */

type Q = [number, number, number, number]
type M3 = [number, number, number, number, number, number, number, number, number]
type V3 = [number, number, number]

// Scratch: carry() runs every frame a tool is in a hand's arc, so nothing is allocated per call.
const QA: Q = [0, 0, 0, 1], QB: Q = [0, 0, 0, 1], QS: Q = [0, 0, 0, 1]
const MA = new Array(9).fill(0) as M3, MB = new Array(9).fill(0) as M3, MS = new Array(9).fill(0) as M3
const GA: V3 = [0, 0, 0], GB: V3 = [0, 0, 0], REF: V3 = [0, 0, 0], C1: V3 = [0, 0, 0], C2: V3 = [0, 0, 0]

function quat(x: number, y: number, z: number, out: Q) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2)
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2)
  out[0] = s1 * c2 * c3 + c1 * s2 * s3
  out[1] = c1 * s2 * c3 - s1 * c2 * s3
  out[2] = c1 * c2 * s3 + s1 * s2 * c3
  out[3] = c1 * c2 * c3 - s1 * s2 * s3
  return out
}

function slerp(a: Q, b: Q, t: number, out: Q) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  // The shorter way round: b and -b are the same rotation.
  const sg = d < 0 ? -1 : 1
  d *= sg
  let sa: number, sb: number
  if (d > 0.9995) {
    sa = 1 - t
    sb = t * sg
  }
  else {
    const th = Math.acos(d)
    sa = Math.sin((1 - t) * th) / Math.sin(th)
    sb = Math.sin(t * th) / Math.sin(th) * sg
  }
  for (let i = 0; i < 4; i++) out[i] = a[i]! * sa + b[i]! * sb
  const l = Math.hypot(out[0], out[1], out[2], out[3])
  for (let i = 0; i < 4; i++) out[i] = out[i]! / l
  return out
}

/** Row-major rotation matrix of a quaternion. */
function mat(q: Q, out: M3) {
  const [x, y, z, w] = q
  out[0] = 1 - 2 * (y * y + z * z)
  out[1] = 2 * (x * y - z * w)
  out[2] = 2 * (x * z + y * w)
  out[3] = 2 * (x * y + z * w)
  out[4] = 1 - 2 * (x * x + z * z)
  out[5] = 2 * (y * z - x * w)
  out[6] = 2 * (x * z - y * w)
  out[7] = 2 * (y * z + x * w)
  out[8] = 1 - 2 * (x * x + y * y)
  return out
}

const wrapNear = (a: number, ref: number) => a + 2 * Math.PI * Math.round((ref - a) / (2 * Math.PI))
const dist = (c: V3, ref: V3) => Math.abs(c[0] - ref[0]) + Math.abs(c[1] - ref[1]) + Math.abs(c[2] - ref[2])

/** Euler XYZ of a matrix into out[3..5]: of the two equivalent triples, the one nearest `ref`. */
function euler(m: M3, ref: V3, out: number[]) {
  const sy = Math.max(-1, Math.min(1, m[2]))
  const y = Math.asin(sy)
  let x: number, z: number
  if (Math.abs(sy) < 0.9999999) {
    x = Math.atan2(-m[5], m[8])
    z = Math.atan2(-m[1], m[0])
  }
  else {
    x = Math.atan2(m[7], m[4])
    z = 0
  }
  C1[0] = wrapNear(x, ref[0])
  C1[1] = wrapNear(y, ref[1])
  C1[2] = wrapNear(z, ref[2])
  C2[0] = wrapNear(x + Math.PI, ref[0])
  C2[1] = wrapNear(Math.PI - y, ref[1])
  C2[2] = wrapNear(z + Math.PI, ref[2])
  const c = dist(C1, ref) <= dist(C2, ref) ? C1 : C2
  out[3] = c[0]
  out[4] = c[1]
  out[5] = c[2]
}

/** Local point p of a tool at `pose`, in its frame's world. */
function at(pose: ArrayLike<number>, m: M3, p: readonly number[], out: V3) {
  out[0] = pose[0]! + m[0] * p[0]! + m[1] * p[1]! + m[2] * p[2]!
  out[1] = pose[1]! + m[3] * p[0]! + m[4] * p[1]! + m[5] * p[2]!
  out[2] = pose[2]! + m[6] * p[0]! + m[7] * p[1]! + m[8] * p[2]!
  return out
}

/**
 * The tool's pose a fraction u (eased) of the way from a to b, carried by the
 * local point `grip`, the grip lifted by `lift` mid-way.
 */
export function carry(a: Pose, b: Pose, u: number, lift: number, grip: readonly number[], out: number[]) {
  if (u <= 0 || u >= 1) {
    const s = u <= 0 ? a : b
    for (let i = 0; i < 6; i++) out[i] = s[i]!
    return
  }
  const e = smoother(u)
  const qa = quat(a[3], a[4], a[5], QA), qb = quat(b[3], b[4], b[5], QB)
  const ga = at(a, mat(qa, MA), grip, GA), gb = at(b, mat(qb, MB), grip, GB)
  const m = mat(slerp(qa, qb, e, QS), MS)
  const gx = ga[0] + (gb[0] - ga[0]) * e
  const gy = ga[1] + (gb[1] - ga[1]) * e + lift * Math.sin(Math.PI * e)
  const gz = ga[2] + (gb[2] - ga[2]) * e
  // The origin sits where the grip lands with this rotation.
  out[0] = gx - (m[0] * grip[0]! + m[1] * grip[1]! + m[2] * grip[2]!)
  out[1] = gy - (m[3] * grip[0]! + m[4] * grip[1]! + m[5] * grip[2]!)
  out[2] = gz - (m[6] * grip[0]! + m[7] * grip[1]! + m[8] * grip[2]!)
  REF[0] = a[3] + (b[3] - a[3]) * e
  REF[1] = a[4] + (b[4] - a[4]) * e
  REF[2] = a[5] + (b[5] - a[5]) * e
  euler(m, REF, out)
}
