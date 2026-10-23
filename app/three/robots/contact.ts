/**
 * Ground-plane contact between robots, the props they play with, static
 * obstacles and the walls of the mat.
 *
 * Pure TypeScript, no three.js: the hero runs it after every fixed step and
 * scripts/test-collisions.ts runs the exact same code headless.
 *
 * Every body is a handful of circles on the ground (XZ), each with an
 * optional height band (y0..y1): two circles only touch if their bands
 * overlap too, so a ball rolls under a duck's torso and meets its feet, and
 * a duck's head clears a block. The robots and props describe their own
 * circles (see each one's updateColliders).
 *
 * Steering separation in the director is the soft first line; this is the
 * hard guarantee. The solver only measures and splits: it finds overlapping
 * circle pairs and tells each body how far to move and how hard it was hit
 * (Body.collide). How a body actually moves is its own business -- the
 * balancer pushes its simulated planar state and takes the hit as an impulse
 * on its pendulum, the duck shifts its pelvis and takes a recovery step. That
 * keeps "the director never writes a robot's position" true here as well.
 *
 * Position: each overlap is split by inverse mass, so a light robot gives
 * way more than a heavy one. A `fixed` circle (a planted foot, a duck in the
 * middle of a hop's crouch) does not move at all and the other body takes the
 * whole correction. Fixed against fixed is left alone (the torso circles keep
 * those apart). Four Gauss-Seidel passes settle a cluster; the hero checks
 * the residual in tests (<= 2 mm).
 *
 * Velocity: on the first pass only, each overlapping pair that is still
 * closing gets ONE impact: the closing speed along the normal, split by mass
 * (what a perfectly inelastic contact would take off each body). Restitution
 * is the body's own (the balancer's bumper bounces, the duck does not).
 */

export interface Collider {
  x: number
  z: number
  /** Radius, m. 0 = inactive this step (a lifted foot). */
  r: number
  /** Velocity of the circle's centre, m/s. */
  vx: number
  vz: number
  /** Cannot be pushed (a planted foot); the other body takes the whole correction. */
  fixed: boolean
  /** Height band above the ground, m (omitted: floor to sky). */
  y0?: number
  y1?: number
}

/** An axis-aligned box on the ground. */
export interface Box { minX: number, maxX: number, minZ: number, maxZ: number }

/**
 * A convex area to keep out of: its bounding box, its outline (x, z pairs,
 * counter-clockwise seen from above) and that outline's edges as half-planes
 * nx * x + nz * z <= c (nx, nz the outward unit normal, three numbers each).
 */
export interface KeepOut extends Box { outline: number[], planes: number[] }

/** A keep-out from any points: their convex hull. */
export function keepOutOf(points: number[]): KeepOut | null {
  const pts: [number, number][] = []
  for (let i = 0; i < points.length; i += 2) pts.push([points[i]!, points[i + 1]!])
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: number[], a: number[], b: number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!)
  const lower: [number, number][] = [], upper: [number, number][] = []
  for (const q of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop()
    lower.push(q)
  }
  for (const q of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop()
    upper.push(q)
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1))
  // Degenerate (fewer than three corners, or all on a line): no area to keep
  // out of -- and no edges, or an infinite slab, to push anything out by.
  let area2 = 0
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!, b = hull[(i + 1) % hull.length]!
    area2 += a[0] * b[1] - b[0] * a[1]
  }
  if (hull.length < 3 || Math.abs(area2) < 1e-10) return null
  // In x (right) and z (toward the viewer) with +y up, the monotone chain's
  // order runs clockwise seen from above; the outward normal of edge a -> b is (b - a) turned (dz, -dx).
  const planes: number[] = []
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!, b = hull[(i + 1) % hull.length]!
    let nx = b[1] - a[1], nz = -(b[0] - a[0])
    const l = Math.hypot(nx, nz) || 1
    nx /= l
    nz /= l
    planes.push(nx, nz, nx * a[0] + nz * a[1])
  }
  // Orientation check: the centroid must be inside every half-plane; flip if not.
  const cx = hull.reduce((s, q) => s + q[0], 0) / hull.length, cz = hull.reduce((s, q) => s + q[1], 0) / hull.length
  if (planes.length && planes[0]! * cx + planes[1]! * cz > planes[2]!) for (let i = 0; i < planes.length; i++) planes[i] = -planes[i]!
  return {
    minX: Math.min(...hull.map(q => q[0])), maxX: Math.max(...hull.map(q => q[0])),
    minZ: Math.min(...hull.map(q => q[1])), maxZ: Math.max(...hull.map(q => q[1])),
    outline: hull.flat(), planes,
  }
}

/**
 * How far point (x, z) is outside keep-out k: the largest of its distances
 * past the edges' lines (< 0: inside), and which edge (index into planes / 3).
 */
export function keepOutDistance(k: KeepOut, x: number, z: number, out: { d: number, e: number }) {
  const p = k.planes
  let d = -Infinity, e = 0
  for (let i = 0; i < p.length; i += 3) {
    const v = p[i]! * x + p[i + 1]! * z - p[i + 2]!
    if (v > d) {
      d = v
      e = i
    }
  }
  out.d = d
  out.e = e
  return out
}

/** Axis-aligned walls (a mat's rails, or the screen's edges), inner faces; and boxes to keep out of. */
export interface Walls extends Box {
  /** Height of the wall top: circles whose band starts above it pass over (a leaning body over a rail). */
  h?: number
  /**
   * Keep-out boxes: solid from floor to sky (the hero's text, projected onto
   * the floor). A circle is pushed out through the nearest face. Impact code
   * WALL - 4 - k.
   */
  keepOut?: KeepOut[]
}

/** Impact hook `j` for a wall: WALL - side (0 -X, 1 +X, 2 -Z, 3 +Z). */
export const WALL = -1000

export interface Obstacle {
  x: number
  z: number
  r: number
  /** Its top, m: circles whose band starts above it pass over (a dog's head over a low ramp). */
  h?: number
  /** A body that passes this obstacle (the wheel-leg rides up the ramp the others walk round). */
  skip?: Body
}

export type ContactOther = 'robot' | 'static'

/** Unit vector on the ground, pointing the way this body is pushed. */
export interface Normal {
  x: number
  z: number
}

export interface Body {
  /** kg, for splitting overlaps and impacts. */
  readonly mass: number
  readonly colliders: readonly Collider[]
  /**
   * Contact response. `normal` points away from the other body; `depth` is
   * this body's share of the overlap (move that far along the normal);
   * `relSpeed` > 0 is this body's share of the closing speed (first pass
   * only); `part` indexes `colliders`. The body must update its colliders
   * before returning, so the next pair sees where it now is.
   */
  collide(normal: Normal, depth: number, relSpeed: number, other: ContactOther, part: number): void
  /** A prop that has come up against something it cannot pass this solve (its own bounds): it gives no more way. */
  readonly blocked?: boolean
}

export const CONTACT = {
  iterations: 8,
  /** Closing speeds below this are resting contact: position only, no impact. */
  minImpact: 0.015,
  /**
   * Jammed: after the passes, a circle still this far (m) into another body
   * or an obstacle is caught in a pile (a fallen wheel-leg between a duck's
   * stance foot, a goal net and a lying dog) that the usual passes do not
   * settle. Up to `slipPasses` more passes run, in which a planted part gives
   * way too -- the foot slips -- rather than leave the overlap.
   */
  jam: 0.001,
  slipPasses: 8,
}
/** In a slip pass: planted parts take their share like any other. */
let slipping = false

/**
 * Called once per impact (first pass): closing speed (m/s), the contact point
 * on the ground, and who hit whom -- body indices i < j, or j = -1 - k for
 * static obstacle k, or WALL - side for a wall.
 */
export type ImpactHook = (speed: number, x: number, z: number, i: number, j: number) => void

/**
 * Robot-robot pairs keep a little air between their footprints (`skin`, m),
 * more when the pair lines up with the camera's view direction (viewX, viewZ:
 * the camera's forward on the ground, unit): there the nearer robot is drawn
 * over the farther one, and parts above the footprint (a duck's head, a
 * leaning frame) would read as passing through it.
 */
export interface ContactOptions {
  skin?: number
  viewSkin?: number
  viewX?: number
  viewZ?: number
  /** The skin applies only between the first `skinBodies` bodies (the robots, not the props). */
  skinBodies?: number
  walls?: Walls
}

/**
 * Does circle a clear a static of top h (an obstacle, the walls)? Its band
 * starts above the top -- or within OVER of it: then it rests on the edge
 * (a lying duck's raised feet across a goal net) and the conflict is a
 * millimetre up, not centimetres sideways, where it has no way out.
 */
export const OVER = 0.01
export const passesOver = (a: Collider, h: number | undefined) => (a.y0 ?? 0) > (h ?? Infinity) - OVER

/** Do two circles' height bands overlap? */
export const bandsMeet = (a: Collider, b: Collider) =>
  (a.y0 ?? -Infinity) < (b.y1 ?? Infinity) && (b.y0 ?? -Infinity) < (a.y1 ?? Infinity)

const nA: Normal = { x: 0, z: 0 }
const nB: Normal = { x: 0, z: 0 }
/** One pair's contacts: p, q, nx, nz, depth, impact share A, impact share B. */
const CF = 7
const MAX_CONTACTS = 64
const cbuf = new Float64Array(MAX_CONTACTS * CF)
let nc = 0

/**
 * Resolve one pair's contacts. Normally each contact on its own (so the
 * deepest and the impact go to the parts that touched). But two bodies can
 * INTERLOCK -- a fallen duck's head across another's body, one circle pushing
 * A left while another pushes it right -- and contact by contact they would
 * shove each other to and fro forever. Then the pair is separated once, as a
 * whole, along the line between the two bodies' centres, by the deepest
 * overlap.
 */
function resolvePair(A: Body, B: Body, count: number, mA: number, mB: number) {
  // Bit 1: A gave way (was moved) in this pair; bit 2: B did.
  let yielded = 0
  let interlocked = false
  for (let k = 0; k < count && !interlocked; k++) {
    for (let l = k + 1; l < count; l++) {
      if (cbuf[k * CF + 2]! * cbuf[l * CF + 2]! + cbuf[k * CF + 3]! * cbuf[l * CF + 3]! < -0.2) {
        interlocked = true
        break
      }
    }
  }
  if (!interlocked) {
    for (let k = 0; k < count; k++) {
      const o = k * CF
      const p = cbuf[o]!, q = cbuf[o + 1]!
      const a = A.colliders[p]!, b = B.colliders[q]!
      let wA = a.fixed && !slipping ? 0 : 1 / mA
      let wB = b.fixed && !slipping ? 0 : 1 / mB
      // A planted foot on a pinned prop (a ball in a corner): the prop still
      // gives way -- the wall puts it right on the next pass.
      if (wA + wB === 0 && !b.fixed) wB = 1 / B.mass
      let w = wA + wB
      if (w === 0) {
        wA = a.fixed ? 0 : 1 / A.mass
        w = wA
      }
      if (w === 0) continue
      if (wA > 0) yielded |= 1
      if (wB > 0) yielded |= 2
      const depth = cbuf[o + 4]!
      nA.x = -cbuf[o + 2]!
      nA.z = -cbuf[o + 3]!
      nB.x = cbuf[o + 2]!
      nB.z = cbuf[o + 3]!
      A.collide(nA, depth * wA / w, cbuf[o + 5]!, 'robot', p)
      B.collide(nB, depth * wB / w, cbuf[o + 6]!, 'robot', q)
    }
    return yielded
  }
  // Interlocked: one push apart along the centre line, by the deepest overlap.
  let deep = 0, kd = 0, sA = 0, sB = 0
  for (let k = 0; k < count; k++) {
    if (cbuf[k * CF + 4]! > deep) {
      deep = cbuf[k * CF + 4]!
      kd = k
    }
    sA += cbuf[k * CF + 5]!
    sB += cbuf[k * CF + 6]!
  }
  let ax = 0, az = 0, an = 0, bx = 0, bz = 0, bn = 0
  for (const c of A.colliders) {
    if (c.r > 0) {
      ax += c.x
      az += c.z
      an++
    }
  }
  for (const c of B.colliders) {
    if (c.r > 0) {
      bx += c.x
      bz += c.z
      bn++
    }
  }
  let dx = bx / bn - ax / an, dz = bz / bn - az / an
  const l = Math.hypot(dx, dz)
  if (l > 1e-9) {
    dx /= l
    dz /= l
  }
  else {
    dx = cbuf[kd * CF + 2]!
    dz = cbuf[kd * CF + 3]!
  }
  const p = cbuf[kd * CF]!, q = cbuf[kd * CF + 1]!
  const fixedA = A.colliders[p]!.fixed, fixedB = B.colliders[q]!.fixed
  let wA = fixedA && !slipping ? 0 : 1 / mA
  let wB = fixedB && !slipping ? 0 : 1 / mB
  // As contact by contact: a planted part against a pinned prop -- the prop
  // still gives way (else neither moves and the overlap stays); failing
  // that, a pinned A does.
  if (wA + wB === 0) {
    if (!fixedB) wB = 1 / B.mass
    else if (!fixedA) wA = 1 / A.mass
  }
  // (Both planted: no move, but each still feels the impact.)
  const w = wA + wB || 1
  nA.x = -dx
  nA.z = -dz
  nB.x = dx
  nB.z = dz
  // How far apart along that line clears EVERY contact circle, not just the
  // deepest: a ball between two feet has normals almost across the line, and
  // only a push out past the feet frees it. Per contact, |d + s u| = R.
  let push = deep
  for (let k = 0; k < count; k++) {
    const ca = A.colliders[cbuf[k * CF]!]!, cb = B.colliders[cbuf[k * CF + 1]!]!
    const ddx = cb.x - ca.x, ddz = cb.z - ca.z
    const R = Math.hypot(ddx, ddz) + cbuf[k * CF + 4]!
    const du = ddx * dx + ddz * dz
    const disc = du * du - (ddx * ddx + ddz * ddz) + R * R
    if (disc > 0) push = Math.max(push, -du + Math.sqrt(disc))
  }
  A.collide(nA, push * wA / w, sA, 'robot', p)
  B.collide(nB, push * wB / w, sB, 'robot', q)
  return (wA > 0 ? 1 : 0) | (wB > 0 ? 2 : 0)
}
const kd = { d: 0, e: 0 }
/**
 * How far circle `a` reaches into keep-out `k` (<= 0: clear), with nA set to
 * the way out: through the edge it is least far inside (the outline grown by
 * the radius, corners square -- a hair conservative at a corner).
 */
function outOfKeep(a: Collider, k: KeepOut) {
  keepOutDistance(k, a.x, a.z, kd)
  if (kd.d >= a.r) return 0
  nA.x = k.planes[kd.e]!
  nA.z = k.planes[kd.e + 1]!
  return a.r - kd.d
}

/**
 * Props that cannot give way freely this solve. 1: it touched a wall or an
 * obstacle (it gives no more way at all). 2: it has given way to a body and
 * is not pushed back into it: `pinDir` holds the way it went, and a later
 * push against that (from the far side of a squeeze) is the pusher's to take.
 */
let pinned = new Uint8Array(16)
let pinDir = new Float64Array(32)
/** A push on a prop "against" its pin direction (cosine below this) goes back into what it gave way to. */
const PIN_BACK = -0.3
/** Mass of body k in this pair (s: +1 for B, -1 for A, the way the gathered normals push it). */
function massOf(k: number, P: Body, s: number, skinN: number) {
  if (k < skinN) return P.mass
  if (pinned[k] === 1 || P.blocked) return Infinity
  if (pinned[k] === 2) {
    for (let c = 0; c < nc; c++) {
      if (s * (cbuf[c * CF + 2]! * pinDir[2 * k]! + cbuf[c * CF + 3]! * pinDir[2 * k + 1]!) < PIN_BACK) return Infinity
    }
  }
  return P.mass
}
/** Prop k gave way in this pair: remember the way it went (depth-weighted). */
function pinTo(k: number, s: number, skinN: number) {
  if (k < skinN || pinned[k] === 1) return
  let x = 0, z = 0
  for (let c = 0; c < nc; c++) {
    x += s * cbuf[c * CF + 2]! * cbuf[c * CF + 4]!
    z += s * cbuf[c * CF + 3]! * cbuf[c * CF + 4]!
  }
  const l = Math.hypot(x, z)
  if (l < 1e-12) return
  pinned[k] = 2
  pinDir[2 * k] = x / l
  pinDir[2 * k + 1] = z / l
}
/** straddle()'s answer: the way out (unit x, z), how far, and the deepest part (the one told). */
const straddleOut = { x: 0, z: 0, d: 0, p: 0 }
/** Its contacts: outward normal x, z, depth, part -- per touching circle and static. */
let stC = new Float64Array(4 * 32)
let stN = 0
function stAdd(nx: number, nz: number, depth: number, p: number) {
  if (4 * stN + 4 > stC.length) {
    const grown = new Float64Array(stC.length * 2)
    grown.set(stC)
    stC = grown
  }
  stC[4 * stN] = nx
  stC[4 * stN + 1] = nz
  stC[4 * stN + 2] = depth
  stC[4 * stN + 3] = p
  stN++
}
/** Directions tried for the way out. */
const ST_DIRS = 32
/**
 * Is body A caught between statics -- obstacles, the walls, the text's
 * keep-outs -- touching them with circles pushed opposite ways (normals
 * more than ~100 degrees apart): a lying duck's raised feet either side of a
 * goal net's post, a fallen wheel-leg between a goal's net and the screen's
 * edge? Contact by contact it would be pushed one way and straight back,
 * for ever. If so, straddleOut holds one push for the whole body: the
 * direction (of ST_DIRS round the circle) that clears every contact soonest
 * -- each needs s (n . u) >= its depth -- and how far.
 */
function straddle(A: Body, obstacles: readonly Obstacle[], walls: Walls | undefined, ka: number) {
  const ca = A.colliders
  stN = 0
  const add = stAdd
  for (const o of obstacles) {
    if (o.skip === A || boxes[ka]! > o.x + o.r || o.x - o.r > boxes[ka + 1]! || boxes[ka + 2]! > o.z + o.r || o.z - o.r > boxes[ka + 3]!) continue
    for (let p = 0; p < ca.length; p++) {
      const a = ca[p]!
      if (a.r <= 0 || a.fixed || passesOver(a, o.h)) continue
      const dx = a.x - o.x, dz = a.z - o.z, d = Math.hypot(dx, dz), R = a.r + o.r
      if (d >= R || d < 1e-9) continue
      add(dx / d, dz / d, R - d, p)
    }
  }
  if (walls) {
    for (let p = 0; p < ca.length; p++) {
      const a = ca[p]!
      if (a.r <= 0 || a.fixed) continue
      if (!passesOver(a, walls.h)) {
        if (walls.minX - (a.x - a.r) > 0) add(1, 0, walls.minX - (a.x - a.r), p)
        if (a.x + a.r - walls.maxX > 0) add(-1, 0, a.x + a.r - walls.maxX, p)
        if (walls.minZ - (a.z - a.r) > 0) add(0, 1, walls.minZ - (a.z - a.r), p)
        if (a.z + a.r - walls.maxZ > 0) add(0, -1, a.z + a.r - walls.maxZ, p)
      }
      for (const k of walls.keepOut ?? []) {
        if (boxes[ka]! > k.maxX || k.minX > boxes[ka + 1]! || boxes[ka + 2]! > k.maxZ || k.minZ > boxes[ka + 3]!) continue
        const depth = outOfKeep(a, k)
        if (depth > 0) add(nA.x, nA.z, depth, p)
      }
    }
  }
  const n = stN
  if (n < 2) return false
  let opposed = false
  for (let i = 0; i < n && !opposed; i++) {
    for (let j = i + 1; j < n; j++) {
      if (stC[4 * i]! * stC[4 * j]! + stC[4 * i + 1]! * stC[4 * j + 1]! < -0.2) {
        opposed = true
        break
      }
    }
  }
  if (!opposed) return false
  // The way out: of ST_DIRS directions, the one needing the shortest move to
  // clear every contact (each needs s (n . u) >= its depth). If no direction
  // clears them all, there is no single way out: contact by contact instead.
  let bestS = Infinity, bestX = 0, bestZ = 0, deep = 0, pd = 0
  for (let i = 0; i < n; i++) {
    if (stC[4 * i + 2]! > deep) {
      deep = stC[4 * i + 2]!
      pd = stC[4 * i + 3]!
    }
  }
  for (let k = 0; k < ST_DIRS; k++) {
    const ux = Math.cos(2 * Math.PI * k / ST_DIRS), uz = Math.sin(2 * Math.PI * k / ST_DIRS)
    let s = 0
    for (let i = 0; i < n && s < bestS; i++) {
      const dot = stC[4 * i]! * ux + stC[4 * i + 1]! * uz
      s = dot < 0.1 ? Infinity : Math.max(s, stC[4 * i + 2]! / dot)
    }
    if (s < bestS) {
      bestS = s
      bestX = ux
      bestZ = uz
    }
  }
  if (bestS === Infinity) return false
  straddleOut.x = bestX
  straddleOut.z = bestZ
  straddleOut.d = bestS
  straddleOut.p = pd
  return true
}
/** Per-body bounding boxes (minX, maxX, minZ, maxZ), grown on demand. */
let boxes = new Float64Array(64)
/** Boxes are padded by this much, so a body nudged earlier in the same pass is still found. */
const BOX_PAD = 0.05

function box(b: Body, k: number) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const c of b.colliders) {
    if (c.r <= 0) continue
    if (c.x - c.r < x0) x0 = c.x - c.r
    if (c.x + c.r > x1) x1 = c.x + c.r
    if (c.z - c.r < z0) z0 = c.z - c.r
    if (c.z + c.r > z1) z1 = c.z + c.r
  }
  boxes[k] = x0 - BOX_PAD
  boxes[k + 1] = x1 + BOX_PAD
  boxes[k + 2] = z0 - BOX_PAD
  boxes[k + 3] = z1 + BOX_PAD
}

/**
 * One contact solve. Deterministic: bodies and circles are visited in array
 * order, and coincident centres separate along a fixed axis. Broad phase:
 * padded bounding boxes per body; a pass that finds nothing touching ends
 * the solve, so a step without contacts costs one cheap pass.
 */
export function solveContacts(bodies: readonly Body[], obstacles: readonly Obstacle[], onImpact?: ImpactHook, opts: ContactOptions = {}) {
  const n = bodies.length
  const skin = opts.skin ?? 0
  const viewSkin = opts.viewSkin ?? 0
  const vx = opts.viewX ?? 0
  const vz = opts.viewZ ?? 0
  if (boxes.length < n * 4) boxes = new Float64Array(n * 8)
  const pad = skin + viewSkin
  const skinN = opts.skinBodies ?? n
  const walls = opts.walls
  if (pinned.length < n) {
    pinned = new Uint8Array(n * 2)
    pinDir = new Float64Array(n * 4)
  }
  pinned.fill(0)
  slipping = false
  for (let it = 0; it < CONTACT.iterations + CONTACT.slipPasses; it++) {
    if (it >= CONTACT.iterations) {
      if (!jammed(bodies, obstacles)) break
      slipping = true
    }
    const first = it === 0
    let touching = false
    for (let i = 0; i < n; i++) box(bodies[i]!, i * 4)
    for (let i = 0; i < n; i++) {
      const A = bodies[i]!
      const ka = i * 4
      for (let j = i + 1; j < n; j++) {
        const kb = j * 4
        if (boxes[ka]! > boxes[kb + 1]! + pad || boxes[kb]! > boxes[ka + 1]! + pad
          || boxes[ka + 2]! > boxes[kb + 3]! + pad || boxes[kb + 2]! > boxes[ka + 3]! + pad) continue
        const B = bodies[j]!
        let impacted = !first
        const ca = A.colliders, cb = B.colliders
        const sk = i < skinN && j < skinN
        const pairSkin = sk ? skin : 0
        const pairView = sk ? viewSkin : 0
        for (let p = 0; p < ca.length; p++) {
          for (let q = 0; q < cb.length; q++) {
            const a = ca[p]!, b = cb[q]!
            if (a.r <= 0 || b.r <= 0 || (a.fixed && b.fixed) || !bandsMeet(a, b)) continue
            let dx = b.x - a.x
            let dz = b.z - a.z
            const d2 = dx * dx + dz * dz
            const Rmax = a.r + b.r + pairSkin + pairView
            if (d2 >= Rmax * Rmax) continue
            const d = Math.sqrt(d2)
            if (d > 1e-9) {
              dx /= d
              dz /= d
            }
            else {
              dx = 1
              dz = 0
            }
            const R = a.r + b.r + pairSkin + pairView * Math.abs(dx * vx + dz * vz)
            if (d >= R) continue
            const depth = R - d
            touching = true
            let sA = 0, sB = 0
            if (!impacted) {
              const closing = (a.vx - b.vx) * dx + (a.vz - b.vz) * dz
              if (closing > CONTACT.minImpact) {
                impacted = true
                const m = A.mass + B.mass
                sA = closing * B.mass / m
                sB = closing * A.mass / m
                onImpact?.(closing, a.x + dx * a.r, a.z + dz * a.r, i, j)
              }
            }
            // Gather this pair's contacts; they are resolved below.
            if (nc < MAX_CONTACTS) {
              const o = nc * CF
              cbuf[o] = p
              cbuf[o + 1] = q
              cbuf[o + 2] = dx
              cbuf[o + 3] = dz
              cbuf[o + 4] = depth
              cbuf[o + 5] = sA
              cbuf[o + 6] = sB
              nc++
            }
          }
        }
        // A prop pinned against a wall or an obstacle cannot give way: the robot takes the push.
        if (nc > 0) {
          const yielded = resolvePair(A, B, nc, massOf(i, A, -1, skinN), massOf(j, B, 1, skinN))
          // A prop that has given way to one body will not be pushed back into
          // it: a robot pressing it from the far side (or the same body again,
          // on a later pass) takes the push itself. Otherwise a ball squeezed
          // between two bodies -- a duck's stance foot, a wheel and a fallen
          // dog -- is shoved to and fro, twenty times lighter than either, and
          // the last pair solved leaves it inside the other. Sideways it still
          // gives way: a ball squeezed out of a gap squirts out.
          if (yielded & 1) pinTo(i, -1, skinN)
          if (yielded & 2) pinTo(j, 1, skinN)
        }
        nc = 0
      }
      // Static obstacles: infinitely heavy, the robot takes everything. A
      // body caught between statics moves once, as a whole (straddle).
      const caught = straddle(A, obstacles, walls, ka)
      if (caught) {
        touching = true
        const p = straddleOut.p, a = A.colliders[p]!
        let s = 0
        if (first) {
          const closing = -(a.vx * straddleOut.x + a.vz * straddleOut.z)
          if (closing > CONTACT.minImpact) {
            s = closing
            onImpact?.(closing, a.x, a.z, i, WALL)
          }
        }
        nA.x = straddleOut.x
        nA.z = straddleOut.z
        A.collide(nA, straddleOut.d, s, 'static', p)
        pinned[i] = 1
      }
      for (let k = 0; k < obstacles.length && !caught; k++) {
        const o = obstacles[k]!
        if (o.skip === A || boxes[ka]! > o.x + o.r || o.x - o.r > boxes[ka + 1]! || boxes[ka + 2]! > o.z + o.r || o.z - o.r > boxes[ka + 3]!) continue
        let impacted = !first
        const ca = A.colliders
        for (let p = 0; p < ca.length; p++) {
          const a = ca[p]!
          if (a.r <= 0 || a.fixed || passesOver(a, o.h)) continue
          let dx = a.x - o.x
          let dz = a.z - o.z
          const R = a.r + o.r
          const d2 = dx * dx + dz * dz
          if (d2 >= R * R) continue
          touching = true
          const d = Math.sqrt(d2)
          if (d > 1e-9) {
            dx /= d
            dz /= d
          }
          else {
            dx = 1
            dz = 0
          }
          let s = 0
          if (!impacted) {
            const closing = -(a.vx * dx + a.vz * dz)
            if (closing > CONTACT.minImpact) {
              impacted = true
              s = closing
              onImpact?.(closing, a.x - dx * a.r, a.z - dz * a.r, i, -1 - k)
            }
          }
          nA.x = dx
          nA.z = dz
          A.collide(nA, R - d, s, 'static', p)
          pinned[i] = 1
        }
      }
      // The mat's walls: rigid, the body takes everything; one impact per wall per step.
      if (walls && !caught) {
        const ca = A.colliders
        for (let side = 0; side < 4; side++) {
          let impacted = !first
          for (let p = 0; p < ca.length; p++) {
            const a = ca[p]!
            if (a.r <= 0 || a.fixed || passesOver(a, walls.h)) continue
            const depth = side === 0 ? walls.minX - (a.x - a.r)
              : side === 1 ? (a.x + a.r) - walls.maxX
                : side === 2 ? walls.minZ - (a.z - a.r)
                  : (a.z + a.r) - walls.maxZ
            if (depth <= 0) continue
            touching = true
            nA.x = side === 0 ? 1 : side === 1 ? -1 : 0
            nA.z = side === 2 ? 1 : side === 3 ? -1 : 0
            let s = 0
            if (!impacted) {
              const closing = -(a.vx * nA.x + a.vz * nA.z)
              if (closing > CONTACT.minImpact) {
                impacted = true
                s = closing
                onImpact?.(closing, a.x - nA.x * a.r, a.z - nA.z * a.r, i, WALL - side)
              }
            }
            A.collide(nA, depth, s, 'static', p)
            pinned[i] = 1
          }
        }
        const ko = walls.keepOut
        if (ko) {
          for (let k = 0; k < ko.length; k++) {
            const b = ko[k]!
            if (boxes[ka]! > b.maxX || b.minX > boxes[ka + 1]! || boxes[ka + 2]! > b.maxZ || b.minZ > boxes[ka + 3]!) continue
            let impacted = !first
            for (let p = 0; p < ca.length; p++) {
              const a = ca[p]!
              if (a.r <= 0 || a.fixed) continue
              const depth = outOfKeep(a, b)
              if (depth <= 0) continue
              touching = true
              let s = 0
              if (!impacted) {
                const closing = -(a.vx * nA.x + a.vz * nA.z)
                if (closing > CONTACT.minImpact) {
                  impacted = true
                  s = closing
                  onImpact?.(closing, a.x - nA.x * a.r, a.z - nA.z * a.r, i, WALL - 4 - k)
                }
              }
              A.collide(nA, depth, s, 'static', p)
              pinned[i] = 1
            }
          }
        }
      }
    }
    if (!touching) break
  }
  slipping = false
}

/** Is any circle still more than CONTACT.jam into another body or an obstacle? */
function jammed(bodies: readonly Body[], obstacles: readonly Obstacle[]) {
  for (let i = 0; i < bodies.length; i++) {
    const A = bodies[i]!
    for (const a of A.colliders) {
      if (a.r <= 0) continue
      for (let j = i + 1; j < bodies.length; j++) {
        for (const b of bodies[j]!.colliders) {
          if (b.r <= 0 || (a.fixed && b.fixed) || !bandsMeet(a, b)) continue
          const R = a.r + b.r - CONTACT.jam, dx = a.x - b.x, dz = a.z - b.z
          if (R > 0 && dx * dx + dz * dz < R * R) return true
        }
      }
      if (a.fixed) continue
      for (const o of obstacles) {
        if (o.skip === A || passesOver(a, o.h)) continue
        const R = a.r + o.r - CONTACT.jam, dx = a.x - o.x, dz = a.z - o.z
        if (dx * dx + dz * dz < R * R) return true
      }
    }
  }
  return false
}

/**
 * Largest remaining overlap between any two movable-vs-anything circle pairs
 * of different bodies, and between bodies and obstacles (m). For tests and
 * the lab readout; fixed-vs-fixed pairs are reported separately.
 */
export function maxOverlap(bodies: readonly Body[], obstacles: readonly Obstacle[], walls?: Walls) {
  let worst = 0
  let fixedPairs = 0
  for (let i = 0; i < bodies.length; i++) {
    const A = bodies[i]!
    for (let j = i + 1; j < bodies.length; j++) {
      for (const a of A.colliders) {
        for (const b of bodies[j]!.colliders) {
          if (a.r <= 0 || b.r <= 0 || !bandsMeet(a, b)) continue
          const o = a.r + b.r - Math.hypot(b.x - a.x, b.z - a.z)
          if (o <= 1e-6) continue
          // Two planted soles can end up touching (a re-aimed swing foot lands flush): count real overlap only.
          if (a.fixed && b.fixed) {
            if (o > 0.0005) fixedPairs++
          }
          else worst = Math.max(worst, o)
        }
      }
    }
    for (const o of obstacles) {
      if (o.skip === A) continue
      for (const a of A.colliders) {
        if (a.r <= 0 || passesOver(a, o.h)) continue
        const ov = a.r + o.r - Math.hypot(a.x - o.x, a.z - o.z)
        if (ov > 0 && !a.fixed) worst = Math.max(worst, ov)
      }
    }
    if (walls) {
      for (const a of A.colliders) {
        if (a.r <= 0 || a.fixed) continue
        if (!passesOver(a, walls.h)) worst = Math.max(worst, walls.minX - (a.x - a.r), (a.x + a.r) - walls.maxX, walls.minZ - (a.z - a.r), (a.z + a.r) - walls.maxZ)
        for (const b of walls.keepOut ?? []) worst = Math.max(worst, outOfKeep(a, b))
      }
    }
  }
  return { worst, fixedPairs }
}
