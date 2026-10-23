/**
 * Dimensions of the "Make Some Noise" sheet, in metres. Pure numbers, shared
 * by the builders, the camera fit and the tests.
 *
 * The noise machine's own frame: x across (its control cheek on -x), y up,
 * z toward the viewer, origin on the floor under its middle. The speaker face
 * is a square plywood plate leaning back by FACE.tilt; facePoint() maps
 * face coordinates (a across, b up the plate from its bottom edge, c out of
 * its front) to machine coordinates, so the speaker, the perfboard and the
 * knobs all line up with the lean.
 */

/** Plywood thickness, every plate. */
export const PLY = 0.012

/**
 * Where the two machines stand on the bench top (x, z). Wide focus boxes put
 * them side by side; squarer ones stagger the plotter forward and to the
 * right, which narrows the composition so both draw larger. frame.ts picks
 * whichever layout draws them larger for the box it is given.
 */
export const PLACES = {
  wide: { machine: [-0.28, 0], plotter: [0.33, 0] },
  tall: { machine: [-0.1, -0.22], plotter: [0.05, 0.3] },
} as const
export type Place = keyof typeof PLACES

export interface Box { x0: number, x1: number, y0: number, y1: number, z0: number, z1: number }

export const BASE = { x0: -0.275, x1: 0.175, z0: -0.13, z1: 0.135, y0: 0.03, t: 0.014 }
export const BASE_TOP = BASE.y0 + BASE.t

export const FACE = { s: 0.3, tilt: 0.28, y: BASE_TOP + 0.002, z: 0.105 }

export const SPK = {
  /** Hole in the face plate, and the gasket ring over it. */
  hole: 0.122,
  ring: 0.138,
  /** Cone outer radius (meets the surround), inner radius (meets the dust cap), depth. */
  coneR: 0.102,
  coneIn: 0.036,
  depth: 0.034,
}

/** The control cheek: a second plate outboard of the box's left side, perfboard between. */
export const CHEEK = { gap: 0.075 }
export const SIDE_X = FACE.s / 2 + PLY / 2
export const CHEEK_X = -(SIDE_X + PLY / 2 + CHEEK.gap + PLY / 2)
export const CHEEK_OUT = CHEEK_X - PLY / 2

/** Knobs and jack on the cheek's outer face, as face coordinates (b up the lean, c behind the face). */
export const KNOBS = [{ b: 0.235, c: -0.048 }, { b: 0.152, c: -0.048 }] as const
export const JACK = { b: 0.074, c: -0.048 }

export function facePoint(a: number, b: number, c: number): [number, number, number] {
  const s = Math.sin(FACE.tilt)
  const k = Math.cos(FACE.tilt)
  return [a, FACE.y + b * k + c * s, FACE.z - b * s + c * k]
}

/** Machine-frame bounds of everything, cable included (for the camera fit). */
export const MACHINE_BOX = { x0: -0.37, x1: 0.18, y0: 0, y1: 0.36, z0: -0.13, z1: 0.24 }

// ── Plotter (its own frame: origin at the bed centre on the floor) ─────────

export const BED = { w: 0.52, d: 0.34, y0: 0.03, t: 0.02 }
export const BED_TOP = BED.y0 + BED.t
/** Paper sheet top surface. */
export const PAPER_Y = BED_TOP + 0.0006
/** How far the pen tip rises off the paper when the solenoid fires. */
export const LIFT_H = 0.009
export const RAIL = { x: 0.197, z0: -0.155, z1: 0.155, post: 0.03, w: 0.026, t: 0.012 }
export const RAIL_TOP = BED_TOP + RAIL.post + RAIL.w
/** The bridge beam sits this far behind the pen axis (the carriage hangs on its front face). */
export const BRIDGE = { z: -0.03, w: 0.026, t: 0.01, truckH: 0.024 }
export const BRIDGE_Y = RAIL_TOP + BRIDGE.truckH + BRIDGE.w / 2
export const PEN_LEN = 0.11

export const PLOTTER_BOX = { x0: -0.26, x1: 0.26, y0: 0, y1: 0.24, z0: -0.18, z1: 0.18 }

// ── The bench (scene frame: y up from the floor) ──────────────────────────

/**
 * A low kit bench both machines stand on: a plywood top on four slotted beam
 * legs, aprons under the top, a shelf on low stretchers. The machines' floor
 * (their y = 0) is the top surface, at TABLE.h. `over` is how far the top runs
 * past the machines' footprint; legs stand `leg.in` in from the top's corners.
 */
export const TABLE = {
  h: 0.4,
  t: 0.024,
  over: 0.05,
  leg: { w: 0.05, t: 0.02, in: 0.06 },
  stretcher: 0.085,
  shelfT: 0.014,
}
/** Top surface of the shelf, which rests on the stretchers. */
export const SHELF_Y = TABLE.stretcher + TABLE.leg.w / 2 + TABLE.shelfT

const shift = (b: Box, x: number, y: number, z: number): Box =>
  ({ x0: b.x0 + x, x1: b.x1 + x, y0: b.y0 + y, y1: b.y1 + y, z0: b.z0 + z, z1: b.z1 + z })

/** Both machines' bounds in the scene frame, standing on the bench top (cable included). */
export function subjectBoxes(place: Place): Box[] {
  const p = PLACES[place]
  return [
    shift(MACHINE_BOX, p.machine[0], TABLE.h, p.machine[1]),
    shift(PLOTTER_BOX, p.plotter[0], TABLE.h, p.plotter[1]),
  ]
}

/** The bench top's plan extents: the machines' footprint plus the overhang. */
export function tableTop(place: Place) {
  const [m, p] = subjectBoxes(place) as [Box, Box]
  return {
    x0: Math.min(m.x0, p.x0) - TABLE.over,
    x1: Math.max(m.x1, p.x1) + TABLE.over,
    z0: Math.min(m.z0, p.z0) - TABLE.over,
    z1: Math.max(m.z1, p.z1) + TABLE.over,
  }
}

/** The whole bench, floor to the props lying on its top. */
export function benchBox(place: Place): Box {
  return { ...tableTop(place), y0: 0, y1: TABLE.h + 0.03 }
}
