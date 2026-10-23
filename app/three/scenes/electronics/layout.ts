/**
 * Electronics bench layout. Units are decimetres (1 = 100 mm) so the parts
 * keep their real proportions -- an 85 x 56 mm board, a 165 x 55 mm
 * breadboard on a 2.54 mm hole pitch, a standard 40 x 20 x 38 mm hobby servo
 * -- while the numbers stay readable. y up, the table at y = 0, the camera's
 * side toward +z. Pure numbers and small pure helpers only: the drawing, the
 * motion and the tests read the same dimensions.
 */

/** Breadboard and header pitch: 0.1 inch. */
export const P = 0.0254

/**
 * The single-board computer, long axis along z, standing on four standoffs.
 * Its 40-pin header runs along the right edge (+x), facing the breadboard, so
 * the jumpers cross the gap directly; the USB and Ethernet blocks sit on the
 * back end (-z), away from the wiring.
 */
export const SBC = {
  x0: -1.62,
  x1: -1.06,
  z0: -0.47,
  z1: 0.38,
  /** Board underside (standoff height) and PCB thickness. */
  y: 0.06,
  t: 0.016,
}
export const SBC_TOP = SBC.y + SBC.t
export const SBC_HOLE_INSET = 0.035

/**
 * Header: two rows at x = HEADER.x -+ P/2. Pin 1 is at the front end (the end
 * away from the ports, as on the real boards); odd pins on the inner row.
 */
export const HEADER = { x: SBC.x1 - 0.035, z1: SBC.z1 - 0.08, baseH: 0.025, pinH: 0.085 }

export function headerPin(n: number): [number, number] {
  const i = Math.floor((n - 1) / 2)
  const outer = (n - 1) % 2 === 1
  return [HEADER.x + (outer ? P / 2 : -P / 2), HEADER.z1 - i * P]
}

/** The breadboard, long axis along x. zc is the centre channel. */
export const BB = { x0: -0.62, x1: 1.03, z0: -0.3, z1: 0.25, h: 0.085 }
export const BB_ZC = (BB.z0 + BB.z1) / 2
export const COLS = 63
const MARGIN = (BB.x1 - BB.x0 - (COLS - 1) * P) / 2

export function colX(c: number) {
  return BB.x0 + MARGIN + c * P
}

/**
 * Terminal rows a..e in front of the channel, f..j behind it (0.3 inch
 * across the channel), then two power rails each side: the inner rail is
 * ground (-), the outer one supply (+).
 */
export type Row = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'gndB' | 'vccB' | 'gndF' | 'vccF'
const ROW_OFFSET: Record<Row, number> = {
  e: 1.5, d: 2.5, c: 3.5, b: 4.5, a: 5.5,
  f: -1.5, g: -2.5, h: -3.5, i: -4.5, j: -5.5,
  gndB: -8, vccB: -9, gndF: 8, vccF: 9,
}
export function rowZ(r: Row) {
  return BB_ZC + ROW_OFFSET[r] * P
}
export const RAIL_ROWS: Row[] = ['gndB', 'vccB', 'gndF', 'vccF']
export const TERMINAL_ROWS: Row[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']

/** Rail holes come in groups of five with a gap, as on the real boards. */
export function railHasHole(c: number) {
  return c >= 1 && c <= 61 && (c - 1) % 6 !== 5
}

/** LEDs, left to right: anode in column LED_COLS[k], cathode one to the right, both in row c (the front half, so no jumper drapes across them). */
export const LED_COLS = [16, 22, 28, 34]
export const LED_COLOURS = ['#FF3B2F', '#FFB000', '#2FCB5A', '#3C78FF']
export const LED = { lift: 0.03, rimR: 0.029, rimH: 0.01, r: 0.025, bodyH: 0.035 }
/** Dome centre of LED k (the emissive dot and glow sit here). */
export function ledCentre(k: number): [number, number, number] {
  return [colX(LED_COLS[k]!) + P / 2, BB.h + LED.lift + LED.rimH + LED.bodyH, rowZ('c')]
}

/** Push button straddling the channel: legs in columns 41 and 44, rows e and f. */
export const BUTTON = { c0: 41, c1: 44, w: 0.12, h: 0.035, capR: 0.035, capH: 0.03, travel: 0.012 }
export const BUTTON_X = (colX(BUTTON.c0) + colX(BUTTON.c1)) / 2

/** Piezo buzzer, legs in columns 50 and 53, row g (behind the channel). */
export const BUZZER = { c0: 50, c1: 53, r: 0.06, h: 0.095, lift: 0.005 }
export const BUZZER_POS: [number, number, number] = [(colX(BUZZER.c0) + colX(BUZZER.c1)) / 2, BB.h + BUZZER.lift, rowZ('g')]

/** Servo lead's 3-pin connector: ground, supply, signal in columns 57..59, row g. */
export const SERVO_PLUG = { c: [57, 58, 59], row: 'g' as Row, h: 0.1 }

/**
 * The hobby servo stands on the table right of the breadboard, output shaft
 * up near its left end. The pointer arm turns in a horizontal plane: 0 deg
 * points +x (right), 90 toward the viewer, 180 points -x, over the breadboard.
 */
export const SERVO_BODY = { x0: 1.29, x1: 1.7, z0: -0.16, z1: 0.04, h: 0.38, flangeY: 0.28, flangeT: 0.025, flangeOver: 0.075 }
export const SHAFT: [number, number] = [SERVO_BODY.x0 + 0.1, (SERVO_BODY.z0 + SERVO_BODY.z1) / 2]
export const HORN_Y = SERVO_BODY.h + 0.022
export const ARM = { len: 0.55, w: 0.07, t: 0.02, y: HORN_Y + 0.024 }

/** Unit direction of the pointer arm at `deg` (0..180), in the x-z plane. */
export function armDir(deg: number): [number, number] {
  const a = (deg * Math.PI) / 180
  return [Math.cos(a), Math.sin(a)]
}

/** Jumper wires from the header to the breadboard. mat: red = supply, dark = ground, mid = signal. */
export interface WireSpec { name: string, pin: number, col: number, row: Row, mat: 'red' | 'dark' | 'mid' }
export const WIRES: WireSpec[] = [
  { name: '5V', pin: 2, col: 2, row: 'vccB', mat: 'red' },
  { name: 'GND', pin: 6, col: 4, row: 'gndB', mat: 'dark' },
  { name: 'GPIO17', pin: 11, col: LED_COLS[0]!, row: 'i', mat: 'mid' },
  { name: 'GPIO27', pin: 13, col: LED_COLS[1]!, row: 'i', mat: 'mid' },
  { name: 'GPIO22', pin: 15, col: LED_COLS[2]!, row: 'i', mat: 'mid' },
  { name: 'GPIO23', pin: 16, col: LED_COLS[3]!, row: 'i', mat: 'mid' },
  { name: 'GPIO24', pin: 18, col: BUTTON.c0, row: 'j', mat: 'dark' },
  { name: 'GPIO25', pin: 22, col: BUZZER.c0, row: 'j', mat: 'mid' },
  { name: 'GPIO18', pin: 12, col: 59, row: 'i', mat: 'dark' },
]

/** Short links lying on the board: [col0, row0, col1, row1, mat]. */
export const LINKS: [number, Row, number, Row, 'red' | 'dark'][] = [
  ...LED_COLS.map(c => [c + 1, 'a', c + 1, 'gndF', 'dark'] as [number, Row, number, Row, 'dark']),
  [BUTTON.c1, 'a', BUTTON.c1, 'gndF', 'dark'],
  [BUZZER.c1, 'j', BUZZER.c1, 'gndB', 'dark'],
  [57, 'j', 57, 'gndB', 'dark'],
  [58, 'j', 58, 'vccB', 'red'],
  [61, 'gndB', 61, 'gndF', 'dark'],
]
