/**
 * Backwater layout and pure kinematics, shared by the simulation (and its
 * tsx tests) and the renderer. No three.js here: the same functions place a
 * coconut at release in sim.ts and draw it on the crown in index.ts, so the
 * two can never disagree about where a part is.
 *
 * Units are metres, y up. The water surface is y = 0. The bank runs along z
 * on the right (x >= BANK.x0); the cheena vala's jetty stands on posts off
 * the bank and its boom reaches out over the water towards -x, so the lever
 * is seen side-on by the three-quarter camera, like the kit's planar linkage.
 */

export type V3 = [number, number, number]

/*
 * The rotations take an optional `out` (which may be `v` itself): the
 * per-step and per-frame callers pass scratch vectors so nothing is
 * allocated while the scene runs. Each result is computed into locals before
 * it is written, so aliasing is safe and the arithmetic -- hence every bit of
 * the result -- is the same either way.
 */
export function rotX(v: V3, a: number, out: V3 = [0, 0, 0]): V3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const y = v[1] * c - v[2] * s
  const z = v[1] * s + v[2] * c
  out[0] = v[0]
  out[1] = y
  out[2] = z
  return out
}

export function rotY(v: V3, a: number, out: V3 = [0, 0, 0]): V3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const x = v[0] * c + v[2] * s
  const z = -v[0] * s + v[2] * c
  out[0] = x
  out[1] = v[1]
  out[2] = z
  return out
}

export function rotZ(v: V3, a: number, out: V3 = [0, 0, 0]): V3 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const x = v[0] * c - v[1] * s
  const y = v[0] * s + v[1] * c
  out[0] = x
  out[1] = y
  out[2] = v[2]
  return out
}

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

// ── Ground ────────────────────────────────────────────────────────────────

/** The water is a slab with a cut-away front, like a diorama tile on the paper. */
export const WATER = { x0: -11.2, x1: 3.5, z0: -4.5, z1: 3.3, bottom: -1.3 }
export const BANK = { x0: 3.5, x1: 14, z0: -4.5, z1: 6.0, top: 0.35 }

/**
 * The whole world drawn, far past the subject (WATER / BANK above are the
 * part the simulation uses): the page shows the scene full bleed, so water
 * and land must reach every screen edge.
 */
export const WORLD = { x0: -95, x1: 80, z1: 70 }
/** The far shore across the back: its water edge, back edge (the horizon line) and height. */
export const FAR = { z: -10.5, back: -13.5, top: 0.3 }
/** Distant palms (on the far shore and the back of the near bank): foot, size, lean. */
export const FAR_PALMS: { x: number, y: number, z: number, s: number, yaw: number, lean: number }[] = [
  [-46, -11.4, 0.5, 0.3, 0.12], [-40, -12.6, 0.42, 1.9, -0.08], [-34.5, -11.3, 0.55, 2.8, 0.2], [-24, -12.8, 0.45, 0.9, -0.15],
  // None straight behind the net or its boom tip as the low shots see them (it would stand in the net).
  [-21.5, -11.6, 0.5, 2.4, 0.08], [-1.5, -11.5, 0.55, 2.2, 0.18],
  [11, -11, 0.6, 0.5, 0.1], [14.5, -8, 0.55, 2.6, -0.12], [19, -12, 0.5, 1.2, 0.08],
].map(([x, z, s, yaw, lean]) => ({ x: x!, y: x! < BANK.x0 ? FAR.top : BANK.top, z: z!, s: s! * 0.8, yaw: yaw!, lean: lean! }))
/** Far cheena valas, on the far shore reaching out over the water toward the viewer. */
export const FAR_NETS: { x: number, z: number, yaw: number, s: number }[] = [
  { x: -27, z: -11.9, yaw: 0.25, s: 0.5 },
  { x: -42, z: -12.1, yaw: -0.15, s: 0.45 },
]

/** Surface height under (x, z): the bank top on land, the water surface elsewhere. */
export function groundAt(x: number): number {
  return x >= BANK.x0 ? BANK.top : 0
}

// ── Cheena vala ───────────────────────────────────────────────────────────

/** Jetty deck: from just past the fulcrum back to (and over) the bank. */
export const DECK = { x0: -0.4, x1: 3.95, z: 1.05, top: 1.0, thick: 0.1 }

/** The pivot pin on top of the A-frame. */
export const FULCRUM: V3 = [0.5, 3.0, 0]

/**
 * The boom is a PAIR of long poles (z = +-gap) pivoting at the fulcrum.
 * Boom-local +x runs out over the water; the boom heads -x in the world
 * (yaw pi), so a positive tilt raises the net end and drops the stones.
 */
export const BOOM = { front: 8.0, rear: 3.0, width: 0.22, gap: 0.16 }

/** Square net held by four spreader poles from the boom tip. Level at tilt thetaRef. */
export const NET = { half: 2.3, drop: 2.6, thetaRef: 0.075, grid: 14, sag: 0.95, floor: -1.15 }

/** Boom-local point -> world at tilt theta. Ry(pi) maps (x, y, z) to (-x, y, -z). */
export function boomToWorld(p: V3, theta: number, out: V3 = [0, 0, 0]): V3 {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const x = p[0] * c - p[1] * s
  const y = p[0] * s + p[1] * c
  const z = p[2]
  out[0] = FULCRUM[0] - x
  out[1] = FULCRUM[1] + y
  out[2] = FULCRUM[2] - z
  return out
}

export const TIP_LOCAL: V3 = [BOOM.front, 0, 0]

/** Spreader end (= net corner) in boom-local coordinates. i: near/far (along the boom), j: side. */
export function cornerLocal(i: 0 | 1, j: 0 | 1): V3 {
  const d = rotZ([(i ? 1 : -1) * NET.half, -NET.drop, (j ? 1 : -1) * NET.half], -NET.thetaRef)
  return add(TIP_LOCAL, d)
}

/** Boom-local net corners, ordered [c00, c10, c01, c11]. */
export const CORNERS_LOCAL = [cornerLocal(0, 0), cornerLocal(1, 0), cornerLocal(0, 1), cornerLocal(1, 1)]

/** World net corners at tilt theta, ordered [c00, c10, c01, c11] (i = u, j = v). Pass `out` (4 vectors) to reuse. */
export function netCorners(theta: number, out?: V3[]): V3[] {
  const r = out ?? CORNERS_LOCAL.map(() => [0, 0, 0] as V3)
  for (let k = 0; k < 4; k++) boomToWorld(CORNERS_LOCAL[k]!, theta, r[k])
  return r
}

/**
 * One point of the hanging net: bilinear between the corners, sagging
 * like cloth in the middle. Below the water it is clamped to a floor so it
 * never pokes out under the slab (it is hidden by the surface anyway).
 */
export function netPoint(c: V3[], u: number, v: number, sag: number, out: V3 = [0, 0, 0]): V3 {
  const [c00, c10, c01, c11] = c as [V3, V3, V3, V3]
  const w00 = (1 - u) * (1 - v)
  const w10 = u * (1 - v)
  const w01 = (1 - u) * v
  const w11 = u * v
  out[0] = c00[0] * w00 + c10[0] * w10 + c01[0] * w01 + c11[0] * w11
  out[2] = c00[2] * w00 + c10[2] * w10 + c01[2] * w01 + c11[2] * w11
  const y = c00[1] * w00 + c10[1] * w10 + c01[1] * w01 + c11[1] * w11 - sag * Math.sin(Math.PI * u) * Math.sin(Math.PI * v)
  out[1] = Math.max(NET.floor, y)
  return out
}

/** Where the counterweight cluster hangs: under the rear end of the boom. */
export const HANG_LOCAL: V3 = [-BOOM.rear, -BOOM.width / 2, 0]

/** Height of the rope blocks (the pin each rope turns on) above the deck: a hauler's waist. */
export const BLOCK_Y = 0.95

/**
 * Operating ropes: from the boom's rear end (boom-local) down to a block on a
 * post on the deck (world), from which a fisher hauls the tail (`tail`: the
 * tail's direction on the deck, from the block toward its fisher).
 *  - rope 0 runs the length of the jetty to a block at its water end and
 *    turns back: its fisher stands facing the water and the net, where he
 *    also works the scoop net at rest;
 *  - rope 1 comes down to a block mid-deck; its fisher faces the bank.
 */
export const ROPES: { from: V3, to: V3, tail: [number, number] }[] = [
  { from: [-BOOM.rear + 0.25, -BOOM.width / 2, BOOM.gap], to: [-0.12, DECK.top + BLOCK_Y, -0.48], tail: [1, -0.6] },
  { from: [-BOOM.rear + 0.25, -BOOM.width / 2, -BOOM.gap], to: [2.3, DECK.top + BLOCK_Y, 0.56], tail: [-1, 0.25] },
]

/**
 * The scoop net: pole length (it reaches the belly of the raised net from the
 * jetty), hoop radius, the pole's radius. It rests on a low rack beside fisher
 * 0's left hip, pointing out over the water (haul.ts scoopRest); `rackY` is the
 * pole's height above the deck there, `hoopOut` how far ahead of his hip the
 * hoop lies, `posts` where the rack's two uprights stand along it (m from his hip).
 */
export const SCOOP = { len: 9.0, hoopR: 0.24, poleR: 0.0225, rackY: 0.86, side: 0.28, hoopOut: 5.0, posts: [1.2, -0.6] as [number, number] }
/** The catch basket, on the deck ahead of fisher 0 and to his right, clear of his rope's post. */
export const BASKET = { x: -0.18, z: -0.8, r: 0.19, h: 0.28 }

/**
 * Counterweight cluster, in its own hanging frame (origin at the hang point,
 * -y down, swinging about z): a yoke on a short rope, stones lashed under it.
 */
export const YOKE_Y = -0.3
export const STONES: { x: number, len: number, w: number, h: number, d: number, rot: number }[] = [
  { x: -0.34, len: 0.16, w: 0.38, h: 0.32, d: 0.36, rot: 0.2 },
  { x: -0.1, len: 0.28, w: 0.42, h: 0.36, d: 0.4, rot: -0.15 },
  { x: 0.14, len: 0.12, w: 0.34, h: 0.3, d: 0.34, rot: 0.35 },
  { x: 0.36, len: 0.24, w: 0.36, h: 0.32, d: 0.36, rot: -0.3 },
]
/** Distance from the hang point to the lowest stone face. */
export const CLUSTER_DEPTH = Math.max(...STONES.map(s => -YOKE_Y + s.len + s.h / 2 + 0.03))
/** Pendulum length to the cluster's centre of mass. */
export const CLUSTER_L = 0.6

// ── Coconut palms ─────────────────────────────────────────────────────────

/** Trunk: a stack of short straight segments, each turned back a little towards vertical. */
export const TRUNK = { n: 10, len: 0.66, r0: 0.16, r1: 0.105, curve: -0.024 }

export interface TrunkSeg { base: V3, angle: number, len: number, rBot: number, rTop: number }

/** Trunk segments in the palm's lean frame (they lie in its xy plane). */
export function trunkSegments(): { segs: TrunkSeg[], top: V3 } {
  const segs: TrunkSeg[] = []
  let p: V3 = [0, 0, 0]
  let a = 0
  for (let i = 0; i < TRUNK.n; i++) {
    const r = (k: number) => TRUNK.r0 + (TRUNK.r1 - TRUNK.r0) * (k / TRUNK.n)
    segs.push({ base: p, angle: a, len: TRUNK.len, rBot: r(i), rTop: r(i + 1) })
    const dir = rotZ([0, 1, 0], a)
    p = [p[0] + dir[0] * TRUNK.len, p[1] + dir[1] * TRUNK.len, 0]
    a += TRUNK.curve
  }
  return { segs, top: p }
}

export const TRUNK_TOP = trunkSegments().top

export interface PalmSpec {
  base: V3
  /** Heading of the lean (rotation about y). */
  yaw: number
  /** Lean at the foot (rotation about the palm's local z; positive leans towards local -x). */
  lean: number
  scale: number
}

export const PALMS: PalmSpec[] = [
  { base: [5.4, BANK.top, -3.5], yaw: -0.35, lean: 0.5, scale: 1.08 },
  { base: [11.1, BANK.top, -1.6], yaw: Math.PI + 0.4, lean: 0.18, scale: 0.95 },
  // Shading the watcher and the visitor: its nuts can land on them.
  { base: [9.5, BANK.top, -0.75], yaw: 0.2, lean: 0.1, scale: 0.82 },
]

/** The crown is set back towards upright on a leaning trunk, as real crowns are. */
export function crownTilt(p: PalmSpec) {
  return -0.6 * p.lean - TRUNK.curve * TRUNK.n * 0.5
}

export const NUT_R = 0.14
/** Coconut cluster under the frond bases, crown-local. */
export const NUTS: V3[] = Array.from({ length: 6 }, (_, k) => {
  const a = k * Math.PI / 3 + 0.35
  const r = 0.2 + (k % 2) * 0.04
  return [Math.cos(a) * r, -0.14 - (k % 3) * 0.07, Math.sin(a) * r] as V3
})

/**
 * Crown-local point q -> world, through the same node chain the renderer
 * builds: root (base, yaw, scale) > lean (z) > bend (x, z) > crown base
 * (trunk top, crownTilt) > sway (x, z) > q. Euler 'XYZ' with y = 0 is Rx.Rz.
 */
const pv: V3 = [0, 0, 0]
export function palmPoint(p: PalmSpec, bend: [number, number], sway: [number, number], q: V3, out: V3 = [0, 0, 0]): V3 {
  // In place on one scratch vector: called for every nut on every frame.
  const v = rotX(rotZ(q, sway[1], pv), sway[0], pv)
  rotZ(v, crownTilt(p), v)
  v[0] = v[0] + TRUNK_TOP[0]
  v[1] = v[1] + TRUNK_TOP[1]
  v[2] = v[2] + TRUNK_TOP[2]
  rotX(rotZ(v, bend[1], v), bend[0], v)
  rotZ(v, p.lean, v)
  v[0] = v[0] * p.scale
  v[1] = v[1] * p.scale
  v[2] = v[2] * p.scale
  rotY(v, p.yaw, v)
  out[0] = v[0] + p.base[0]
  out[1] = v[1] + p.base[1]
  out[2] = v[2] + p.base[2]
  return out
}
