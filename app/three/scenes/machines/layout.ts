import { AXLE_Y, SHAFTS } from './gears'
import type { WheelSpec } from './odometer'

/**
 * Machine room layout in world metres: y up, the base board's top at y = 0,
 * the camera's side +z. The counter is a split-flap display on the front of
 * a yellow case, the seconds unit's centre at x = 0; the gear train stands on the RIGHT side frame, in a plane
 * facing +x, and drives the case through an axle at (y = AXLE_Y, z = 0).
 * The train's own 2D frame (gears.ts) maps to world as x_plate -> -z,
 * y -> y, and the plate's outward normal (local +z) is world +x.
 *
 * The counter is the page's only countdown, so it is drawn big: everything
 * is sized from the printed figure outward (GLYPH_H first, then the cards
 * that carry it, then the case that carries the cards). Next to it the train
 * reads as the mechanism that drives the display.
 */

/**
 * Printed figure height. Dela Gothic One's figures are about as wide as they
 * are tall, so the card width, not the height, is what limits them: a card
 * is the figure plus 15 % of air across, and half again as tall.
 */
export const GLYPH_H = 0.18

/**
 * One split-flap unit: card width, the height of each half card (a flap),
 * the split between the halves (the hinge line), the gap between the units
 * of a group (a tenth of a card: separate cards, not one strip), and the gap
 * between the two columns of groups.
 */
export const FLAP = { w: 0.212, half: 0.133, split: 0.005, gap: 0.021, colGap: 0.115 }
/** Full card height, both halves and the split. */
export const CARD_H = 2 * FLAP.half + FLAP.split

export const BEAM = { w: 0.05, t: 0.016 }

/** The ink panel round each group's cards, this far past them on every side. */
export const PANEL_PAD = 0.026

/** The group name plates (DAYS ... SECONDS) under the cards: one size for every group, two units wide. */
export const LABEL = { w: 2 * FLAP.w + FLAP.gap - 0.04, h: 0.064 }
/**
 * Space on the case face, measured from the cards (so each includes the
 * panel's pad): card bottom to its plate, plate to the next row's cards,
 * and the margins to the case's edges. Generous on purpose -- the case is
 * a calm object with a display on it, not a box packed with figures.
 */
const SPACE = { toLabel: PANEL_PAD + 0.022, toRow: PANEL_PAD + 0.056, bottom: 0.05, top: PANEL_PAD + 0.056, left: PANEL_PAD + 0.064, right: PANEL_PAD + 0.05 }

export type Group = 'days' | 'hours' | 'minutes' | 'seconds'
/**
 * The display is two rows of two groups -- DAYS HOURS over MINUTES SECONDS,
 * like a station board -- not one long row: in a single row nine wide figures
 * made a long low bar that a phone could only draw small. Each group is
 * right-aligned in its column (figures align right, as in a table), so the
 * seconds sit at the bottom right, next to the drive.
 */
const ROWS: Group[][] = [['days', 'hours'], ['minutes', 'seconds']]

export interface GroupBox { group: Group, units: number[], x0: number, x1: number, hinge: number, labelY: number }

/**
 * The display's geometry: each unit's centre x and hinge height, and each
 * group's extent. The bottom row's hinge is the drive axle's height, so the
 * axle out of the train turns the seconds unit's spool directly.
 */
export function display(list: WheelSpec[]) {
  const unitsOf = (g: Group) => list.map((w, j) => (w.group === g ? j : -1)).filter(j => j >= 0)
  const width = (g: Group) => unitsOf(g).length * FLAP.w + (unitsOf(g).length - 1) * FLAP.gap
  const col = [0, 1].map(c => Math.max(...ROWS.map(r => width(r[c]!))))
  const right = [FLAP.w / 2 - col[1]! - FLAP.colGap, FLAP.w / 2]
  const rowStep = CARD_H + SPACE.toLabel + LABEL.h + SPACE.toRow
  const x = new Array<number>(list.length)
  const hinge = new Array<number>(list.length)
  const groups: GroupBox[] = []
  ROWS.forEach((row, r) => {
    const h = AXLE_Y + (ROWS.length - 1 - r) * rowStep
    row.forEach((g, c) => {
      const units = unitsOf(g)
      const x1 = right[c]!
      const x0 = x1 - width(g)
      units.forEach((u, k) => {
        x[u] = x0 + FLAP.w / 2 + k * (FLAP.w + FLAP.gap)
        hinge[u] = h
      })
      groups.push({ group: g, units, x0, x1, hinge: h, labelY: h - CARD_H / 2 - SPACE.toLabel - LABEL.h / 2 })
    })
  })
  return {
    x,
    hinge,
    groups,
    /** The case: the display plus its margins, standing on the foot rails. */
    caseX: [right[0]! - col[0]! - SPACE.left, FLAP.w / 2 + SPACE.right] as [number, number],
    caseY: [AXLE_Y - CARD_H / 2 - SPACE.toLabel - LABEL.h - SPACE.bottom, AXLE_Y + rowStep + CARD_H / 2 + SPACE.top] as [number, number],
  }
}

/**
 * The nameplate. With three day units the DAYS column is a unit wider than
 * MINUTES under it, which leaves a patch of bare case at the bottom left
 * that reads as a hole; an ink plate engraved with the opening date fills
 * it, top level with the bottom row's panels and bottom level with their
 * name plates, 50 mm from the case's edge and clear of the MINUTES panel.
 * With two day units both columns are the same width, there is no patch,
 * and there is no plate (null).
 */
export const PLATE_GAP = { edge: 0.055, panel: 0.035 }
export function nameplate(list: WheelSpec[]) {
  const D = display(list)
  const minutes = D.groups.find(g => g.group === 'minutes')!
  const x0 = D.caseX[0] + PLATE_GAP.edge
  const x1 = minutes.x0 - PANEL_PAD - PLATE_GAP.panel
  if (x1 - x0 < 0.1) return null
  return { x0, x1, y0: minutes.labelY - LABEL.h / 2, y1: minutes.hinge + CARD_H / 2 + PANEL_PAD }
}

/** The yellow case, front to back just deep enough to house the flap spools. */
export const CASE = { front: 0.12, back: -0.12, marginR: SPACE.right, panelT: 0.01 }
/** Card and flap planes (world z). A falling flap swings out in front of the case by up to a half card. */
export const CARD_Z = CASE.front + CASE.panelT + 0.001
export const FLAP_Z = CARD_Z + 0.003

/**
 * The right side frame's plane: clear of the case's side by the truss's two
 * back layers (the brace sits 2 x BEAM.t inboard of the plate).
 */
export const PLATE_X = FLAP.w / 2 + CASE.marginR + 2.5 * BEAM.t + 0.01
/** Layer offsets outward from the plate (world +x). Beams sit at 0. */
export const LAYER = [0.035, 0.065, 0.095]
export const GEAR_T = 0.018
/** Crank arm and its grip, outermost on shaft K. */
export const CRANK = { z: 0.09, arm: 0.15, grip: 0.05 }
/** Foliot (the escapement's balance bar) on the anchor arbor, outside the anchor. */
export const FOLIOT = { z: 0.115, half: 0.16, weightR: 0.026 }

/**
 * Camera azimuth and elevation (radians) by the frame's aspect -- the
 * stage's focus box, not the screen. Every box this scene gets is limited by
 * WIDTH, and width is what sets the figure size. On a phone (0.77) the
 * figures need all of it: the view comes round toward the front (12 deg),
 * which shortens the side frame's reach to the right of the case, and rises
 * into the spare height. Anything squarer (the desktop box is about 0.9,
 * 21:9 about 1.3) has width to spare, so the view turns to 26 deg and the
 * gears open up into wheels beside the case. The cards stand upright, so
 * the elevation stays low enough that they read nearly square-on.
 */
export function viewAngles(aspect: number) {
  const t = Math.min(1, Math.max(0, (aspect - 0.78) / (0.92 - 0.78)))
  return { az: (12 + 14 * t) * Math.PI / 180, el: (18 - 9 * t) * Math.PI / 180 }
}

/** Plate-local (x back, y up, z out) to world. */
export function plateToWorld(lx: number, ly: number, lz: number): [number, number, number] {
  return [PLATE_X + lz, ly, -lx]
}

/**
 * The base board under everything (top at y = 0): the feet's footprint and
 * a little round it, out in front far enough to catch the falling flaps'
 * sweep. Parts in the air (the crank's sweep, the big wheel at the back)
 * overhang it, so the board never sets the drawing's width.
 */
export function board(list: WheelSpec[]) {
  return {
    x0: display(list).caseX[0] - 0.04,
    x1: PLATE_X + 0.075,
    z0: -(SHAFTS.K.x + 0.11),
    z1: FLAP_Z + FLAP.half + FLAP.split / 2 + 0.03,
    t: 0.035,
  }
}

export { AXLE_Y }
