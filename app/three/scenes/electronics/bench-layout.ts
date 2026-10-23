/**
 * The maker's electronics workbench, in METRES (the people library's unit, so
 * a seated operator drops in at scale 1). y up, the floor at y = 0, the bench
 * runs along x, its front edge toward +z (the camera's side), the operator
 * sits in front of it facing -z.
 *
 * The electronics on the mat keep their own decimetre layout (layout.ts) and
 * are placed here through WORK (an origin and a 0.1 scale), so the parts keep
 * their real sizes: an 85 mm board on a 600 mm mat on a 3.1 m bench.
 *
 * Pure numbers and small pure helpers only: the drawing, the simulation, the
 * operator contract and the tests all read these.
 */

export type V3 = [number, number, number]

/** Bench top: butcher block, surface at TOP. */
export const TOP = 0.78
export const BENCH = { x0: -1.55, x1: 1.55, z0: -0.38, z1: 0.38, t: 0.045, staves: 7 }

/**
 * Steel tool-chest pedestals with a knee well between them (the operator
 * sits in it). Drawer heights run from the top down, as fractions of the
 * carcass height above the plinth.
 */
export const PLINTH = 0.05
export const PED = {
  z0: -0.35,
  z1: 0.31,
  top: TOP - BENCH.t,
  left: { x0: -1.5, x1: -0.47, drawers: [0.1, 0.1, 0.13, 0.15, 0.19, 0.33] },
  right: { x0: 0.37, x1: 1.5, drawers: [0.1, 0.1, 0.13, 0.15, 0.52] },
}

/** The operator's stool and seat (for person.setStance('sit', { seatHeight: SEAT.top })). */
export const SEAT = {
  x: -0.13,
  z: 0.68,
  /** Seat top height (world y). */
  top: 0.52,
  r: 0.17,
  t: 0.035,
  /** Person heading for placeAt (people library: 0 faces +z, so pi faces the bench). */
  heading: Math.PI,
  /** Footrest ring height and half-size. */
  ring: 0.2,
  ringHalf: 0.17,
  /** Leg foot half-spread at the floor. */
  spread: 0.21,
  legTop: 0.11,
}

/** Silicone soldering mat: the scene's one beam-blue accent. */
export const MAT = { x: 0.03, z: 0.1, w: 0.62, d: 0.42, t: 0.006 }
export const MAT_TOP = TOP + MAT.t

/** The decimetre electronics layout's origin on the mat (layout.ts y = 0 = mat top). */
export const WORK = { x: 0.1, y: MAT_TOP, z: -0.045, scale: 0.1 }

/** A decimetre layout point to world metres. */
export function workToWorld(x: number, y: number, z: number): V3 {
  return [WORK.x + x * WORK.scale, WORK.y + y * WORK.scale, WORK.z + z * WORK.scale]
}

// ── The job on the mat: a small perfboard held up by the helping hands ────

/**
 * Perfboard in the helping hands' clips, tilted toward the operator by `tilt`
 * (rotation about x), centre at (x, y, z). Board frame: u along x (width),
 * n the board normal (up and toward the operator), v in the board plane.
 */
export const PB = { x: -0.15, y: MAT_TOP + 0.062, z: 0.15, w: 0.075, h: 0.05, t: 0.0016, tilt: 0.6 }
export const PB_U: V3 = [1, 0, 0]
export const PB_N: V3 = [0, Math.cos(PB.tilt), Math.sin(PB.tilt)]
export const PB_V: V3 = [0, -Math.sin(PB.tilt), Math.cos(PB.tilt)]

/** Solder pads in board coordinates (u, v), metres: two resistor pairs and a header pair. */
export const PADS: [number, number][] = [
  [-0.026, 0.012], [-0.012, 0.012], [0.002, -0.01], [0.016, -0.01], [0.024, 0.014], [0.03, 0.014],
]
export const JOINTS = PADS.length
/** Joints soldered per session (the iron goes back to its holder between sessions). */
export const PER_SESSION = 3

/** World position of pad k on the board's front face. */
export function padWorld(k: number): V3 {
  const [a, b] = PADS[k]!
  const h = PB.t / 2
  return [
    PB.x + PB_U[0] * a + PB_V[0] * b + PB_N[0] * h,
    PB.y + PB_U[1] * a + PB_V[1] * b + PB_N[1] * h,
    PB.z + PB_U[2] * a + PB_V[2] * b + PB_N[2] * h,
  ]
}

/** Helping hands: a cast base behind the board, a post, two jointed arms to the clips. */
export const HH = { x: -0.15, z: 0.07, baseW: 0.1, baseD: 0.06, baseH: 0.02, post: 0.11 }

// ── Iron, holder, station ─────────────────────────────────────────────────

/**
 * The iron, along its axis from the tip (0) to the cable end. GRIP is where a
 * pen grip holds it (fingertips on the grip sleeve), measured from the tip.
 */
export const IRON = { tip: 0.03, shaft: 0.075, grip: 0.165, end: 0.19, r: 0.011, gripAt: 0.105 }

/** The coil holder: the tip rests at HOLDER.tip, the handle points along HOLDER_AXIS (toward the operator). */
const ha = norm([-0.55, 0.5, 0.6])
export const HOLDER_AXIS: V3 = ha
export const HOLDER = { x: 0.38, z: 0.1, tip: [0.38, TOP + 0.04, 0.1] as V3, coil0: 0.03, coil1: 0.13, coilR: 0.019, slide: 0.15 }

/**
 * Tip-to-handle axis while working: from the operator's right, rising about
 * 30 degrees off the board's face (a right-handed iron). Kept well across the
 * camera's line of sight so the iron reads as a pen, not a dot.
 */
export const WORK_AXIS: V3 = norm([0.85, 0.4, 0.33])

/** Soldering station and its cable port; the hot-air station beside it. */
export const STATION = { x: 0.62, z: -0.17, w: 0.13, h: 0.1, d: 0.16, port: [0.62, TOP + 0.03, -0.09] as V3 }
export const HOTAIR = { x: 0.86, z: -0.19, w: 0.15, h: 0.12, d: 0.18 }

/** Solder spool on its stand; the wire leaves the spool at SPOOL.exit. */
export const SPOOL = { x: -0.46, z: 0.2, r: 0.04, w: 0.03, axleY: TOP + 0.055, exit: [-0.46, TOP + 0.095, 0.2] as V3 }
/**
 * Solder wire held out of the left hand. A long stick: the hand rests on the
 * mat with the forearm on the bench, and the wire rises from the fingers to
 * the joint (how a steady solderer works, and it keeps the near forearm out
 * of the line of sight to the joint).
 */
export const SOLDER = { stick: 0.15 }

// ── Other tools ───────────────────────────────────────────────────────────

/** Benchtop drill press at the left end. Spindle axis vertical at (x, sz). */
export const DRILL = {
  x: -1.22, z: -0.04, sz: 0.0,
  base: { w: 0.2, d: 0.3, h: 0.02 },
  columnZ: -0.13, columnH: 0.54,
  table: TOP + 0.17,
  headY0: TOP + 0.4, headY1: TOP + 0.5,
  /** Spindle nose at rest, chuck and bit lengths, quill travel. */
  nose: TOP + 0.385, chuck: 0.04, bit: 0.06, travel: 0.085,
  /** Feed handle hub, spoke length; it turns travel / pinion radians over the full travel. */
  hub: [-1.22 + 0.085, TOP + 0.44, -0.02] as V3, spoke: 0.11, pinion: 0.05,
  work: { w: 0.09, h: 0.035, d: 0.07 },
}

/** Mitre saw at the right end. The arm pivots about x at PIVOT; the blade turns in the y-z plane. */
export const SAW = {
  x: 1.16, z: 0.02,
  base: { w: 0.38, d: 0.44, h: 0.05 },
  tableR: 0.15,
  pivot: [1.16, TOP + 0.15, -0.18] as V3,
  /** Pivot to blade centre, blade radius, arm angle raised / lowered (rad, + = up). */
  reach: 0.17, bladeR: 0.105, up: 0.68, down: -0.12,
  fenceZ: -0.1,
  work: { len: 0.42, w: 0.05, h: 0.025 },
}

/** Multimeter on its stand, left of the mat; leads clipped to the breadboard's rails. */
export const METER = { x: -0.62, z: 0.0, w: 0.09, h: 0.18, d: 0.04, lean: 0.42, yaw: -0.3 }

/** Articulated magnifier lamp: clamp on the back edge, two arms, a ring head over the board. */
export const LAMP = {
  base: [-0.43, TOP, -0.32] as V3,
  j0: [-0.43, TOP + 0.07, -0.32] as V3,
  j1: [-0.36, TOP + 0.48, -0.16] as V3,
  j2: [-0.19, TOP + 0.42, 0.09] as V3,
  head: [-0.16, TOP + 0.35, 0.15] as V3,
  headR: 0.075,
}

/** Battery packs lined up along the back, one on a charger. */
export const BATTERIES = { x0: -1.0, dx: 0.088, n: 4, z: -0.25, charger: [-0.6, -0.25] as [number, number] }

/** Slotted-beam rack behind the bench: uprights, a shelf on brackets, a tool rail. */
export const RACK = {
  xs: [-1.38, 0.08, 1.38],
  z: -0.395,
  y0: TOP - 0.1,
  y1: 1.66,
  shelfY: 1.44,
  shelfZ0: -0.43,
  shelfZ1: -0.16,
  shelfX0: -1.48,
  shelfX1: 1.48,
  railY: 1.13,
  w: 0.05,
  t: 0.018,
}

// ── Operator ──────────────────────────────────────────────────────────────

/** Hands at rest: right flat on the bench beside the mat, left holding the solder wire. */
export const RIGHT_REST: V3 = [0.06, MAT_TOP + 0.03, 0.29]
export const LEFT_REST: V3 = [-0.36, TOP + 0.03, 0.25]
/** Solder wire direction out of the left hand at rest and while feeding (toward the joint, from its left). */
export const SOLDER_DIR_REST: V3 = norm([0.9, -0.08, -0.42])
export const SOLDER_DIR_FEED: V3 = norm([0.87, 0.37, -0.33])

/**
 * Reach envelope of a seated adult on the stool, leaning a little toward the
 * work: shoulder centres and the arm's reach (shoulder to palm centre). The
 * smallest adult variant (1.56 m) reaches about 0.6 m; the scene keeps every
 * grip inside 0.56 m.
 */
export const REACH = {
  right: [SEAT.x + 0.18, SEAT.top + 0.56, SEAT.z - 0.12] as V3,
  left: [SEAT.x - 0.18, SEAT.top + 0.56, SEAT.z - 0.12] as V3,
  r: 0.56,
}

// ── Small vector helpers (pure) ───────────────────────────────────────────

export function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

export function dist(a: V3, b: V3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

export function lerp3(a: V3, b: V3, t: number, out: V3 = [0, 0, 0]): V3 {
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
  return out
}

export function add3(a: V3, b: V3, s = 1): V3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]
}
