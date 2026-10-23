/**
 * Workshop layout, in metres: y up, floor at y = 0, the bench centred on the
 * origin with its front edge toward +z (the camera's side). Pure numbers and
 * small pure helpers only -- the drawing, the motion and the tests all read
 * the same dimensions, so "the saw stays in its kerf" is checked against the
 * board that is actually drawn.
 */

/** Bench top surface height. */
export const H = 0.82
export const TOP_T = 0.06
export const BENCH = { x0: -0.75, x1: 0.75, z0: -0.28, z1: 0.28 }
/** Leg beams: centre lines at x = +-LEG.x, z = +-LEG.z. */
export const LEG = { x: 0.62, z: 0.2, w: 0.07, t: 0.04, y0: 0.06, y1: 0.725, stretcher: 0.18 }

/**
 * The workpiece: a board on edge in the front vice, its back face against the
 * bench's front edge, its top edge standing 12 cm proud of the bench top so
 * the saw's toe clears the bench while it cuts.
 */
export const BOARD = {
  x0: -0.62,
  x1: 0.36,
  top: H + 0.12,
  bottom: H - 0.04,
  t: 0.028,
  back: BENCH.z1,
  front: BENCH.z1 + 0.028,
  z: BENCH.z1 + 0.014,
}

/**
 * Front vice. The tommy bar hangs vertical through the screw head (where it
 * drops when the vice is tightened), so it does not stick out across the
 * carpenter's legs; the screw stands only a hand's width proud of the jaw.
 */
export const VICE = { x: -0.45, w: 0.34, h: 0.2, t: 0.045, screwY: H - 0.13, proud: 0.045 }

/**
 * Tool rack behind the bench: two uprights, two crossbars, one peg. It holds
 * a back saw that is part of the still drawing; the working tools lie on the
 * bench top within the carpenter's reach (the rack is half a metre beyond the
 * board -- nobody saws at the vice and reaches that far).
 */
export const RACK = { x: 0.42, z: -0.3, low: H + 0.22, high: H + 0.52, peg: 0.25, pegZ: -0.21 }

/**
 * Saw: toe at the local origin, teeth along local -x to the heel, blade up +y.
 * At work it rips down into the board's free end, blade in the board's middle
 * plane (facing the viewer), teeth line falling `angle` toward the toe; Euler
 * (0, 0, -angle) is the whole orientation. It strokes along its own teeth line,
 * so the teeth always pass through the kerf bottom where it leaves the end grain.
 */
export const SAW = {
  teeth: 0.4,
  angle: 0.22,
  /** Distance from the end grain to the toe at mid stroke. */
  s0: 0.16,
  /** Half the stroke: long, unhurried strokes, as a carpenter rips. */
  amp: 0.15,
  period: 1.1,
  strokes: 3,
  /** Kerf deepening (at the end grain) per metre of push stroke. */
  cutRate: 0.035,
  maxDepth: 0.045,
}

/** Plane: local origin at the sole centre, +x forward. Glide centre positions along the board's top edge. */
export const PLANE = { len: 0.24, x0: -0.49, x1: -0.21, throat: [0.02, 0.034] as const }

/** Chisel: local origin at the cutting edge, axis +y. */
export const CHISEL = { len: 0.23, x: -0.02, blow: 0.004 }

/** Mallet: local origin at the grip end of the handle (the wrist pivot), head centre at -R on x. */
export const MALLET = { R: 0.26, hh: 0.055, rh: 0.011 }
/** Wrist pivot height during chopping: the striking face meets the chisel top at angle 0 with no mortise cut yet. */
export const PIVOT_Y = BOARD.top + CHISEL.len + MALLET.hh

/** [x, y, z, rx, ry, rz] -- Euler XYZ, the three.js default order. */
export type Pose = [number, number, number, number, number, number]
export type ToolKey = 'saw' | 'plane' | 'chisel' | 'mallet'

/**
 * Where each tool waits between jobs: laid out along the bench top just
 * behind the board, handles toward the carpenter, where the hands can reach
 * them (carpenter.ts and the tests check every grip is in reach).
 */
const SAW_TILT = Math.asin(0.011 / 0.52)
/** A small wooden block on the bench top that holds the chisel upright. */
export const CHISEL_BLOCK = { x: 0.25, z: 0.24, w: 0.06, d: 0.05, top: H + 0.05 }
export const REST: Record<ToolKey, Pose> = {
  // Lying flat on its handle's side, blade running back across the bench (the
  // toe over the back edge), handle toward the carpenter: the hand closes on
  // it from above with the forearm square to the grip. Tipped so the toe
  // touches the top as well as the handle.
  saw: [-0.26, H + 0.001, -0.34, -Math.PI / 2 - SAW_TILT, 0, Math.PI / 2],
  // Sole down at the vice end, turned nose to the back: the tote toward the
  // carpenter, clear of the saw's handle.
  plane: [-0.66, H, 0.15, 0, Math.PI / 2, 0],
  // Stood upright in its block (the tip in a socket), handle up, where the
  // left hand finds it over the board.
  chisel: [CHISEL_BLOCK.x, CHISEL_BLOCK.top - 0.03, CHISEL_BLOCK.z, 0, 0, 0],
  // Laid down with its handle toward the carpenter, tipped onto the head's
  // inner edge and the handle's end: the right hand takes it thumb up, as it
  // will hold it, and only has to swing it a quarter turn to the work.
  mallet: [-0.47, H + MALLET.rh, 0.26, 0, -Math.PI / 2, -0.19],
}

/**
 * The drawing is MIRRORED in x (index.ts draws everything but the person in
 * a group scaled -1 in x): with the vice to the carpenter's right and the
 * board's free end ahead of them, a right-handed carpenter facing along the
 * board has the work line in front of the RIGHT shoulder -- the saw and the
 * plane are driven by an arm that never crosses the body. The sim keeps its
 * own (unmirrored) frame; world x = MIRROR x sim x for everything it poses.
 */
export const MIRROR = -1

/**
 * The carpenter (carpenter.ts), in WORLD coordinates (already mirrored):
 * where they stand for each job and which way they face (the people
 * library's heading; -pi/2 faces -x, along the board toward its free end).
 * Found by search (reach every grip exactly; the driving grip 6-30 cm to the
 * right of the body's midline and 25-60 cm in front; the body clear of the
 * bench, board and vice). The plane is pushed while walking with it: the
 * body travels `planeTravel` along the stroke.
 */
export const CARPENTER = {
  variant: 'shirt' as const,
  seed: 31,
  stands: {
    plane: { x: 0.72, z: 0.65, h: -2.3 },
    saw: { x: 0.25, z: 0.65, h: -2.1 },
    chisel: { x: 0.29, z: 0.78, h: -2.7 },
  },
  planeTravel: 0.24,
  /** Step back from the bench to watch the stool, metres. */
  back: 0.22,
}

// ── Stool ─────────────────────────────────────────────────────────────────

export const STOOL = {
  x: 1.08,
  z: 0.12,
  seat: { w: 0.32, t: 0.035, top: 0.46 },
  leg: { w: 0.034, at: 0.125, top: 0.425, tenon: 0.024 },
  rung: { r: 0.01, yx: 0.14, yz: 0.19 },
  /** Exploded offsets: seat up, legs and rungs out along their joint axes, all lifted a little. */
  lift: 0.2,
  spread: 0.1,
  float: 0.04,
}

export interface StoolPart {
  kind: 'seat' | 'leg' | 'rungX' | 'rungZ'
  /** Assembled position of the part node, relative to the stool origin on the floor. */
  base: [number, number, number]
  /** Fully exploded offset. */
  dir: [number, number, number]
}

/**
 * Parts and their explode directions. A leg at corner (sx, sz) moves out
 * along both rung axes at once; each rung moves with the legs across its own
 * axis, so it stays lined up with its sockets and only separates along it --
 * an exploded view that still reads as joints.
 */
export const STOOL_PARTS: StoolPart[] = (() => {
  const { at } = STOOL.leg
  const { spread: d, float: f, lift } = STOOL
  const parts: StoolPart[] = [{ kind: 'seat', base: [0, STOOL.seat.top - STOOL.seat.t / 2, 0], dir: [0, lift, 0] }]
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push({ kind: 'leg', base: [sx * at, 0, sz * at], dir: [sx * d, f, sz * d] })
  }
  for (const s of [-1, 1]) {
    parts.push({ kind: 'rungX', base: [0, STOOL.rung.yx, s * at], dir: [0, f, s * d] })
    parts.push({ kind: 'rungZ', base: [s * at, STOOL.rung.yz, 0], dir: [s * d, f, 0] })
  }
  return parts
})()

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const smooth = (v: number) => {
  const x = clamp01(v)
  return x * x * (3 - 2 * x)
}
export const smoother = (v: number) => {
  const x = clamp01(v)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

/** Explode progress below which the frame (legs and rungs) is fully seated. */
export const STOOL_FRAME_AT = 0.35

/**
 * Explode factors for progress u in [0, 1]: the seat lifts first, then the
 * frame spreads; run backwards, the frame closes before the seat drops on.
 * Both are exactly 0 at u = 0, so reassembly lands on the assembled transforms.
 */
export function stoolFactors(u: number): { seat: number, frame: number } {
  return { seat: smoother(u / 0.6), frame: smoother((u - STOOL_FRAME_AT) / (1 - STOOL_FRAME_AT)) }
}

export function stoolPartPosition(p: StoolPart, u: number, out: [number, number, number]) {
  const f = stoolFactors(u)
  const k = p.kind === 'seat' ? f.seat : f.frame
  out[0] = p.base[0] + p.dir[0] * k
  out[1] = p.base[1] + p.dir[1] * k
  out[2] = p.base[2] + p.dir[2] * k
  return out
}

// ── Surfaces loose things settle on ───────────────────────────────────────

/** Horizontal rectangles [x0, x1, z0, z1, y]. The floor (y = 0) catches everything else. */
const SURFACES: [number, number, number, number, number][] = [
  [BENCH.x0, BENCH.x1, BENCH.z0, BENCH.z1, H],
  [BOARD.x0, BOARD.x1, BOARD.back, BOARD.front, BOARD.top],
  [VICE.x - VICE.w / 2, VICE.x + VICE.w / 2, BOARD.front, BOARD.front + VICE.t, H],
]

/**
 * The surface a body falling from y0 to y1 over (x, z) lands on this step, or
 * null if it is still in the air. Only surfaces it crosses count, so a chip
 * that fell past the bench edge is not lifted back onto the top.
 */
export function landing(x: number, z: number, y0: number, y1: number): number | null {
  let best: number | null = null
  for (const [a, b, c, d, y] of SURFACES) {
    if (x < a || x > b || z < c || z > d) continue
    if (y0 >= y && y1 <= y && (best === null || y > best)) best = y
  }
  if (best !== null) return best
  return y1 <= 0 ? 0 : null
}
