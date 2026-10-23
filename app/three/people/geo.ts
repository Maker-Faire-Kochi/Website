import * as THREE from 'three'

/**
 * Geometry primitives for the people: smooth lofted bodies and the hairlines
 * that draw them.
 *
 * WHY LOFTS, NOT PLATES. The kit's beams are extruded plates: a flat front
 * face whose crease outline IS the drawing. A body built that way reads as a
 * stack of planks. A person is round, so every body part here is a loft --
 * rings of points (a superellipse cross-section per ring) joined into a smooth
 * tube -- and the drawing comes from two kinds of hairline instead:
 *  - CREASES (cap rims, hems, cuffs, garment edges) and explicit SEAMS
 *    (plackets, folds, brows, glasses): always drawn;
 *  - SILHOUETTE CANDIDATES: every other edge of a curved surface, stored with
 *    the normals of its two faces. The line shader (person.ts) draws such an
 *    edge only where one face turns toward the camera and the other away, i.e.
 *    on the outline of the figure as it is seen right now, whatever the pose.
 * So a round body still gets one fine ink outline, like the kit's parts do,
 * at no extra draw call: all of it is in the person's one LineSegments.
 *
 * Pure geometry, no materials; units are metres in a bone's own frame.
 */

export type V3 = [number, number, number]

const TAU = Math.PI * 2

/** Polar radius of a superellipse with half-axes a, b and exponent e, in direction th. */
export function seRadius(a: number, b: number, e: number, th: number) {
  const c = Math.abs(Math.cos(th)) / a
  const s = Math.abs(Math.sin(th)) / b
  return 1 / Math.pow(Math.pow(c, e) + Math.pow(s, e), 1 / e)
}

/** A horizontal cross-section: half-width a (X), half-depth b (Z), centre (x, z) at height y, exponent e. */
export interface Sec { y: number, a: number, b: number, x?: number, z?: number, e?: number }

/** Uniform Catmull-Rom through the keys, by key index; returns a section at fractional index s. */
export function secAt(keys: Sec[], s: number): Required<Sec> {
  const n = keys.length
  const i = Math.max(0, Math.min(n - 2, Math.floor(s)))
  const t = Math.max(0, Math.min(1, s - i))
  const k = (j: number) => keys[Math.max(0, Math.min(n - 1, j))]!
  const p0 = k(i - 1), p1 = k(i), p2 = k(i + 1), p3 = k(i + 2)
  const cr = (f: (q: Sec) => number) => {
    const a = f(p0), b = f(p1), c = f(p2), d = f(p3)
    return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t)
  }
  return {
    y: cr(q => q.y),
    a: Math.max(1e-5, cr(q => q.a)),
    b: Math.max(1e-5, cr(q => q.b)),
    x: cr(q => q.x ?? 0),
    z: cr(q => q.z ?? 0),
    e: cr(q => q.e ?? 2.2),
  }
}

/**
 * The section at height y (keys monotonic in y, either direction). The spline
 * is sampled once per key list into a table (cached), then looked up by
 * binary search and linear blend: shells evaluate thousands of points.
 */
const secTables = new WeakMap<Sec[], Required<Sec>[]>()
const TABLE = 96
export function secAtY(keys: Sec[], y: number): Required<Sec> {
  let tab = secTables.get(keys)
  if (!tab) {
    tab = []
    const n = (keys.length - 1) * TABLE
    for (let i = 0; i <= n; i++) tab.push(secAt(keys, i / TABLE))
    secTables.set(keys, tab)
  }
  const up = tab[tab.length - 1]!.y > tab[0]!.y
  let lo = 0, hi = tab.length - 1
  if ((y <= tab[0]!.y) === up) return tab[0]!
  if ((y >= tab[hi]!.y) === up) return tab[hi]!
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if ((tab[mid]!.y < y) === up) lo = mid
    else hi = mid
  }
  const A = tab[lo]!, Bq = tab[hi]!
  const u = (y - A.y) / ((Bq.y - A.y) || 1)
  const l = (f: number, g: number) => f + (g - f) * u
  return { y, a: l(A.a, Bq.a), b: l(A.b, Bq.b), x: l(A.x, Bq.x), z: l(A.z, Bq.z), e: l(A.e, Bq.e) }
}

/** Point on the surface described by keys at polar angle th (0 = +X, PI/2 = +Z front) and height y. */
export function surfPoint(keys: Sec[], th: number, y: number, out = 0): V3 {
  const s = secAtY(keys, y)
  const r = seRadius(s.a, s.b, s.e, th) + out
  return [s.x + r * Math.cos(th), y, s.z + r * Math.sin(th)]
}

export interface SurfOpts {
  /** Ring is a closed loop (default) or an open strip (no wrap, no caps). */
  closed?: boolean
  /** Faces point inward (the inside wall of a collar or cuff). */
  inward?: boolean
  capStart?: boolean
  capEnd?: boolean
}

/**
 * A surface from a grid of points: rings[t][j]. Closed rings wrap; the ring
 * winding is fixed automatically so faces point outward (away from the axis).
 * Caps are flat fans with their own (flat) normals.
 */
export function surface(rings: V3[][], o: SurfOpts = {}): THREE.BufferGeometry {
  const closed = o.closed ?? true
  const m = rings.length
  const n = rings[0]!.length
  // Outward winding: for a closed loft the ring must turn right-handed about the axis.
  const c0 = centroid(rings[0]!), c1 = centroid(rings[m - 1]!)
  const axis = sub(c1, c0)
  let flip: boolean
  if (closed) {
    let nm = newell(rings[Math.floor(m / 2)]!)
    if (len(nm) < 1e-12) nm = newell(rings[0]!)
    flip = dot(nm, axis) < 0
  }
  else {
    // Open strips are always generated with the angle turning from +X to +Z
    // (right-handed about -Y): outward when the rings run downward.
    flip = axis[1] > 0
  }
  if (o.inward) flip = !flip
  const pos: number[] = []
  const idx: number[] = []
  for (const r of rings) {
    for (let j = 0; j < n; j++) {
      const p = r[flip ? (closed ? (n - j) % n : n - 1 - j) : j]!
      pos.push(p[0], p[1], p[2])
    }
  }
  const cols = closed ? n : n - 1
  for (let i = 0; i < m - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const j1 = (j + 1) % n
      const a = i * n + j, b = i * n + j1, c = (i + 1) * n + j, d = (i + 1) * n + j1
      idx.push(a, b, c, b, d, c)
    }
  }
  const g = new THREE.BufferGeometry()
  const parts: THREE.BufferGeometry[] = []
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  parts.push(g)
  // Hairline candidates straight from the quad grid: the edges between quads
  // (never the triangles' diagonals), each with the two quad normals.
  const P = (i: number, j: number): V3 => { const k = (i * n + (j % n)) * 3; return [pos[k]!, pos[k + 1]!, pos[k + 2]!] }
  const Q: V3[][] = []
  for (let i = 0; i < m - 1; i++) {
    const row: V3[] = []
    for (let j = 0; j < cols; j++) {
      const a = P(i, j), bq = P(i, j + 1), c = P(i + 1, j), dq = P(i + 1, j + 1)
      const nq = add(cross(sub(bq, a), sub(c, a)), cross(sub(dq, bq), sub(c, bq)))
      const l = len(nq)
      row.push(l > 1e-14 ? scale(nq, 1 / l) : [0, 0, 0])
    }
    Q.push(row)
  }
  const E: EdgeData = { pos: [], n1: [], n2: [], kind: [] }
  const seg = (a: V3, bq: V3, n1: V3 | null, n2: V3 | null, rim = 0) => {
    if (len(sub(a, bq)) < 1e-9) return
    E.pos.push(a[0], a[1], a[2], bq[0], bq[1], bq[2])
    const z: V3 = [0, 0, 0]
    const u = n1 ?? z, v = n2 ?? z
    E.n1.push(u[0], u[1], u[2])
    E.n2.push(v[0], v[1], v[2])
    E.kind.push(n1 && n2 ? 1 : rim)
  }
  const deg = (q: V3) => q[0] === 0 && q[1] === 0 && q[2] === 0
  // Along the tube: between quad j-1 and quad j.
  for (let i = 0; i < m - 1; i++) {
    for (let j = 0; j <= cols; j++) {
      if (closed && j === cols) continue
      const left = closed ? Q[i]![(j - 1 + cols) % cols]! : j > 0 ? Q[i]![j - 1]! : null
      const right = j < cols ? Q[i]![j]! : null
      if ((left && deg(left)) || (right && deg(right))) continue
      seg(P(i, j), P(i + 1, j), left, right)
    }
  }
  // Around the tube: between ring rows, and the end rims (against the cap, or open).
  const capN = (end: boolean): V3 | null => {
    const nm = newell(rings[end ? m - 1 : 0]!)
    const l = len(nm)
    if (l < 1e-14) return null
    let c = scale(nm, 1 / l)
    if (flip) c = scale(c, -1)
    return end ? c : scale(c, -1)
  }
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < cols; j++) {
      const below = i > 0 ? Q[i - 1]![j]! : null
      const above = i < m - 1 ? Q[i]![j]! : null
      let n1 = below, n2 = above
      if (closed && i === 0 && (o.capStart ?? true)) n1 = capN(false)
      if (closed && i === m - 1 && (o.capEnd ?? true)) n2 = capN(true)
      if ((n1 && deg(n1)) || (n2 && deg(n2))) continue
      seg(P(i, j), P(i, j + 1), n1, n2, i === 0 ? 2 : i === m - 1 ? 3 : 0)
    }
  }
  if (closed) {
    const cap = (r: V3[], end: boolean) => {
      // An indexed fan with its own (flat) vertices: start cap faces back along the axis, end cap forward.
      const c = centroid(r)
      const p: number[] = [c[0], c[1], c[2]]
      for (let j = 0; j < n; j++) {
        const a = r[flip ? (n - j) % n : j]!
        p.push(a[0], a[1], a[2])
      }
      const ix: number[] = []
      for (let j = 0; j < n; j++) {
        const a = 1 + j, b = 1 + (j + 1) % n
        if (end) ix.push(0, a, b)
        else ix.push(0, b, a)
      }
      const cg = new THREE.BufferGeometry()
      cg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
      cg.setIndex(ix)
      cg.computeVertexNormals()
      parts.push(cg)
    }
    if (o.capStart ?? true) cap(rings[0]!, false)
    if (o.capEnd ?? true) cap(rings[m - 1]!, true)
  }
  if (parts.length === 1) {
    g.userData.edges = E
    return g
  }
  const out = mergeIndexed(parts)
  parts.forEach(q => q.dispose())
  out.userData.edges = E
  return out
}

/** A tube through horizontal sections (sampled smoothly), n points per ring. */
export function tube(keys: Sec[], n: number, per = 2, o: SurfOpts & { th0?: number, th1?: number, disp?: (th: number, y: number) => number } = {}) {
  const rings: V3[][] = []
  const steps = (keys.length - 1) * per
  const closed = o.closed ?? true
  const th0 = o.th0 ?? 0, th1 = o.th1 ?? TAU
  for (let k = 0; k <= steps; k++) {
    const s = secAt(keys, k / per)
    const r: V3[] = []
    const cnt = closed ? n : n + 1
    for (let j = 0; j < cnt; j++) {
      const th = closed ? (j / n) * TAU : th0 + (th1 - th0) * j / n
      const rad = seRadius(s.a, s.b, s.e, th) + (o.disp ? o.disp(th, s.y) : 0)
      r.push([s.x + rad * Math.cos(th), s.y, s.z + rad * Math.sin(th)])
    }
    rings.push(r)
  }
  return surface(rings, o)
}

/**
 * A tube swept along a path, rings square to the path: fingers, thumbs, plaits.
 * radii[i] = [half-size in the bend plane, half-size across it]; `ref` is a
 * direction never parallel to the path (the bend axis).
 */
export function sweep(path: V3[], radii: [number, number][], n: number, ref: V3 = [0, 0, 1]) {
  const rings: V3[][] = []
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!
    const a = path[Math.max(0, i - 1)]!, b = path[Math.min(path.length - 1, i + 1)]!
    let t = sub(b, a)
    t = scale(t, 1 / (len(t) || 1))
    let nn = cross(t, ref)
    nn = scale(nn, 1 / (len(nn) || 1))
    const bb = cross(nn, t)
    const [ra, rb] = radii[i]!
    const r: V3[] = []
    for (let j = 0; j < n; j++) {
      const th = (j / n) * TAU
      const c = Math.cos(th) * ra, s2 = Math.sin(th) * rb
      r.push([p[0] + nn[0] * c + bb[0] * s2, p[1] + nn[1] * c + bb[1] * s2, p[2] + nn[2] * c + bb[2] * s2])
    }
    rings.push(r)
  }
  return surface(rings)
}

/**
 * A shell over a body surface between two height curves: rings run from top(th)
 * to bottom(th) (t = 0..1); R(th, y) gives the point. Hair, scarves, beards,
 * drapes and garment panels are shells.
 */
export function shell(
  pt: (th: number, y: number) => V3,
  top: (th: number) => number,
  bottom: (th: number) => number,
  n: number,
  rings: number,
  o: SurfOpts & { th0?: number, th1?: number } = {},
) {
  const closed = o.closed ?? true
  const th0 = o.th0 ?? 0, th1 = o.th1 ?? TAU
  const out: V3[][] = []
  for (let k = 0; k <= rings; k++) {
    const t = k / rings
    const r: V3[] = []
    const cnt = closed ? n : n + 1
    for (let j = 0; j < cnt; j++) {
      const th = closed ? th0 + (j / n) * TAU : th0 + (th1 - th0) * j / n
      const y0 = top(th), y1 = bottom(th)
      r.push(pt(th, y0 + (y1 - y0) * t))
    }
    out.push(r)
  }
  return surface(out, o)
}

/** Smooth interpolation over angle: table of [deg, value] pairs, symmetric about the Z axis (x mirrored). */
export function angleTable(table: [number, number][]) {
  // th in radians, 0 = +X, PI/2 = front. Fold to [-90, 90] deg measured from the side toward the front.
  return (th: number) => {
    let deg = Math.atan2(Math.sin(th), Math.abs(Math.cos(th))) * 180 / Math.PI
    deg = Math.max(-90, Math.min(90, deg))
    for (let i = 0; i < table.length - 1; i++) {
      const [d0, v0] = table[i]!, [d1, v1] = table[i + 1]!
      if ((deg >= d1 && deg <= d0) || (deg >= d0 && deg <= d1)) {
        const u = (deg - d0) / (d1 - d0 || 1)
        const s = u * u * (3 - 2 * u)
        return v0 + (v1 - v0) * s
      }
    }
    return table[deg > 0 ? 0 : table.length - 1]![1]
  }
}

// ── Hairlines ─────────────────────────────────────────────────────────────

/**
 * Line data of a part: segment end points, and per segment the two face
 * normals (zero = always drawn). Built in the part's own frame.
 */
export interface LineData { pos: number[], n1: number[], n2: number[] }

/** Grid edges of a surface: kind 1 = between two faces; open boundaries: 0 = a side edge, 2 = the start rim, 3 = the end rim. */
export interface EdgeData { pos: number[], n1: number[], n2: number[], kind: number[] }

/** Sort a surface's grid edges into always-drawn creases and silhouette candidates. */
export function classifyEdges(e: EdgeData, creaseDeg: number, out: LineData, rims: boolean | 'noStart' = true) {
  const cc = Math.cos(creaseDeg * Math.PI / 180)
  const cf = Math.cos(0.3 * Math.PI / 180)
  for (let k = 0; k < e.kind.length; k++) {
    const a: V3 = [e.pos[k * 6]!, e.pos[k * 6 + 1]!, e.pos[k * 6 + 2]!]
    const b: V3 = [e.pos[k * 6 + 3]!, e.pos[k * 6 + 4]!, e.pos[k * 6 + 5]!]
    const kind = e.kind[k]!
    if (kind !== 1) {
      if (rims === true || (rims === 'noStart' && kind !== 2)) pushSeg(out, a, b, [0, 0, 0], [0, 0, 0])
      continue
    }
    const n1: V3 = [e.n1[k * 3]!, e.n1[k * 3 + 1]!, e.n1[k * 3 + 2]!]
    const n2: V3 = [e.n2[k * 3]!, e.n2[k * 3 + 1]!, e.n2[k * 3 + 2]!]
    const d = dot(n1, n2)
    if (d > cf) continue
    if (d < cc) pushSeg(out, a, b, [0, 0, 0], [0, 0, 0])
    else pushSeg(out, a, b, n1, n2)
  }
  return out
}

export function emptyLines(): LineData {
  return { pos: [], n1: [], n2: [] }
}

/**
 * Edges of a mesh: creases (angle above creaseDeg, or open boundaries) always
 * drawn; smooth edges kept as silhouette candidates; coplanar ones dropped.
 */
export function meshLines(g: THREE.BufferGeometry, creaseDeg = 40, out = emptyLines()): LineData {
  const p = g.attributes.position as THREE.BufferAttribute
  const index = g.index
  const tri = index ? index.count / 3 : p.count / 3
  const ids = new Map<string, number>()
  const vid: number[] = []
  const vp: V3[] = []
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1e5)}_${Math.round(y * 1e5)}_${Math.round(z * 1e5)}`
  for (let i = 0; i < p.count; i++) {
    const k = key(p.getX(i), p.getY(i), p.getZ(i))
    let id = ids.get(k)
    if (id === undefined) {
      id = vp.length
      ids.set(k, id)
      vp.push([p.getX(i), p.getY(i), p.getZ(i)])
    }
    vid.push(id)
  }
  const edges = new Map<number, { a: number, b: number, n: V3[] }>()
  const nv = vp.length
  for (let t = 0; t < tri; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2
    const a = vid[i0]!, b = vid[i1]!, c = vid[i2]!
    if (a === b || b === c || a === c) continue
    const fn = cross(sub(vp[b]!, vp[a]!), sub(vp[c]!, vp[a]!))
    const l = len(fn)
    if (l < 1e-14) continue
    const nrm = scale(fn, 1 / l)
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const lo = Math.min(u, v), hi = Math.max(u, v)
      const k = lo * nv + hi
      const e = edges.get(k)
      if (e) e.n.push(nrm)
      else edges.set(k, { a: lo, b: hi, n: [nrm] })
    }
  }
  const cosCrease = Math.cos(creaseDeg * Math.PI / 180)
  const cosFlat = Math.cos(0.2 * Math.PI / 180)
  for (const e of edges.values()) {
    const A = vp[e.a]!, Bp = vp[e.b]!
    if (e.n.length === 2) {
      const d = dot(e.n[0]!, e.n[1]!)
      if (d > cosFlat) continue
      if (d >= cosCrease) {
        pushSeg(out, A, Bp, e.n[0]!, e.n[1]!)
        continue
      }
    }
    else if (e.n.length > 2) {
      continue
    }
    pushSeg(out, A, Bp, [0, 0, 0], [0, 0, 0])
  }
  return out
}

function pushSeg(out: LineData, a: V3, b: V3, n1: V3, n2: V3) {
  out.pos.push(a[0], a[1], a[2], b[0], b[1], b[2])
  out.n1.push(n1[0], n1[1], n1[2], n1[0], n1[1], n1[2])
  out.n2.push(n2[0], n2[1], n2[2], n2[0], n2[1], n2[2])
}

/** An always-drawn polyline (a seam, a fold, a brow). */
export function polyline(out: LineData, pts: V3[], closed = false) {
  for (let i = 0; i < pts.length - 1; i++) pushSeg(out, pts[i]!, pts[i + 1]!, [0, 0, 0], [0, 0, 0])
  if (closed && pts.length > 2) pushSeg(out, pts[pts.length - 1]!, pts[0]!, [0, 0, 0], [0, 0, 0])
}

export function transformLines(l: LineData, m: THREE.Matrix4): LineData {
  const nm = new THREE.Matrix3().getNormalMatrix(m)
  const v = new THREE.Vector3()
  const out = emptyLines()
  for (let i = 0; i < l.pos.length; i += 3) {
    v.set(l.pos[i]!, l.pos[i + 1]!, l.pos[i + 2]!).applyMatrix4(m)
    out.pos.push(v.x, v.y, v.z)
    v.set(l.n1[i]!, l.n1[i + 1]!, l.n1[i + 2]!).applyMatrix3(nm)
    out.n1.push(v.x, v.y, v.z)
    v.set(l.n2[i]!, l.n2[i + 1]!, l.n2[i + 2]!).applyMatrix3(nm)
    out.n2.push(v.x, v.y, v.z)
  }
  return out
}

// ── Small vector helpers ──────────────────────────────────────────────────

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2])

function centroid(r: V3[]): V3 {
  const c: V3 = [0, 0, 0]
  for (const p of r) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2] }
  return scale(c, 1 / r.length)
}

function newell(r: V3[]): V3 {
  const nm: V3 = [0, 0, 0]
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!, b = r[(i + 1) % r.length]!
    nm[0] += (a[1] - b[1]) * (a[2] + b[2])
    nm[1] += (a[2] - b[2]) * (a[0] + b[0])
    nm[2] += (a[0] - b[0]) * (a[1] + b[1])
  }
  return nm
}

/** Merge indexed geometries with position + normal, keeping them indexed. */
export function mergeIndexed(list: THREE.BufferGeometry[]) {
  let count = 0, icount = 0
  for (const g of list) { count += g.attributes.position!.count; icount += g.index!.count }
  const pos = new Float32Array(count * 3)
  const nor = new Float32Array(count * 3)
  const idx = new Uint32Array(icount)
  let o = 0, io = 0
  for (const g of list) {
    pos.set(g.attributes.position!.array as Float32Array, o * 3)
    nor.set(g.attributes.normal!.array as Float32Array, o * 3)
    const gi = g.index!
    for (let i = 0; i < gi.count; i++) idx[io + i] = gi.getX(i) + o
    o += g.attributes.position!.count
    io += gi.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  return out
}

/** Merge non-indexed geometries with position + normal. */
export function mergeSimple(list: THREE.BufferGeometry[]) {
  let count = 0
  for (const g of list) count += g.attributes.position!.count
  const pos = new Float32Array(count * 3)
  const nor = new Float32Array(count * 3)
  let o = 0
  for (const g of list) {
    const p = g.attributes.position as THREE.BufferAttribute
    const nn = g.attributes.normal as THREE.BufferAttribute | undefined
    pos.set(p.array as Float32Array, o * 3)
    if (nn) nor.set(nn.array as Float32Array, o * 3)
    o += p.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  return out
}
