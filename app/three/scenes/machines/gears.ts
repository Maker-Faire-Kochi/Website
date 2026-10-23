/**
 * The machine room's gear train as plain numbers: tooth counts, shaft
 * positions, involute tooth outlines and every gear's angle as a function of
 * ONE train coordinate. Pure on purpose -- the drawing, the hover labels and
 * scripts/test-machines.ts all read the same train, so "the teeth never
 * interpenetrate" is checked against the outlines that are actually extruded.
 *
 * Coordinates are the side plate's own 2D frame, in metres: x runs toward the
 * back of the machine, y up. The odometer axle (shaft O) sits at x = 0.
 *
 * The train coordinate g is "seconds of displayed time": it rises one unit per
 * second the counter shows passing. Shaft O carries the seconds drum (ten
 * faces, one per second), so it turns once every 10 units of g; every other
 * shaft's period follows from the tooth counts, never the other way round.
 */

/** Gear module (pitch diameter per tooth), metres. Every meshing pair shares it. */
export const MODULE = 0.01
/** Pressure angle of the involute flanks. */
export const PRESSURE = 20 * Math.PI / 180
/**
 * Arc removed from each tooth at the pitch circle. Zero-backlash gears touch
 * on the line of action, which floats and draws as z-fighting flanks; a hair
 * of clearance is what real gears have too.
 */
export const BACKLASH = 0.07 * MODULE

export type ShaftId = 'O' | 'M' | 'K' | 'X'
export type GearId = 'A' | 'B' | 'C' | 'D' | 'E'

export interface GearSpec {
  id: GearId
  teeth: number
  shaft: ShaftId
  /**
   * Layer outward from the side plate (0 = nearest). Gears only mesh within a
   * layer. The crank pair sits outside the C-D-E layer so pinion B is seen
   * meshing with A in front of its own wheel C, not hidden behind it.
   */
  layer: number
}

/**
 * A: the crank wheel (driven by hand, or by the clock between turns).
 * B/C: a compound pair on one shaft. D: the pinion on the odometer axle.
 * E: the escape arbor's wheel; the escape wheel rides on the same arbor.
 *
 *   crank K (60 s/turn)  A36 -> B12   on M (20 s)
 *                        C24 -> D12   on O (10 s, the seconds drum)
 *                        D12 -> E36   on X (30 s, the escape wheel, 15 teeth)
 */
export const GEARS: GearSpec[] = [
  { id: 'A', teeth: 36, shaft: 'K', layer: 1 },
  { id: 'B', teeth: 12, shaft: 'M', layer: 1 },
  { id: 'C', teeth: 24, shaft: 'M', layer: 0 },
  { id: 'D', teeth: 12, shaft: 'O', layer: 0 },
  { id: 'E', teeth: 36, shaft: 'X', layer: 0 },
]

/** Meshing pairs, ordered outward from shaft O so phases chain from the axle. */
export const MESHES: [GearId, GearId][] = [['D', 'C'], ['B', 'A'], ['D', 'E']]

export const gear = (id: GearId) => GEARS.find(g => g.id === id)!
export const pitchR = (teeth: number) => MODULE * teeth / 2
export const outerR = (teeth: number) => pitchR(teeth) + MODULE
export const rootR = (teeth: number) => pitchR(teeth) - 1.25 * MODULE
/** Centre distance of a meshing pair: the sum of the pitch radii, nothing else. */
export const centreDistance = (a: number, b: number) => pitchR(a) + pitchR(b)

/**
 * Height of the drive axle above the base board top: it turns the seconds
 * unit's flap spool, so it is the bottom row's hinge line, and the case
 * (layout.ts) stands on its foot rails exactly below that. Low, because
 * every centimetre here raises the escapement on top of the train.
 */
export const AXLE_Y = 0.3135

const dir = (deg: number) => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)] as const

/**
 * Shaft centres, solved from the meshes: each shaft is placed at exactly the
 * centre distance from the shaft that drives it, along a chosen direction.
 * The directions are the only free choice (the composition); the distances
 * come from the tooth counts.
 */
export const SHAFTS: Record<ShaftId, { x: number, y: number }> = (() => {
  const O = { x: 0, y: AXLE_Y }
  const dOM = centreDistance(gear('D').teeth, gear('C').teeth)
  const [mx, my] = dir(-20)
  const M = { x: O.x + dOM * mx, y: O.y + dOM * my }
  const dMK = centreDistance(gear('B').teeth, gear('A').teeth)
  const [kx, ky] = dir(30)
  const K = { x: M.x + dMK * kx, y: M.y + dMK * ky }
  const dOX = centreDistance(gear('D').teeth, gear('E').teeth)
  const X = { x: O.x, y: O.y + dOX }
  return { O, M, K, X }
})()

/** Turns of each shaft per unit of g, and its sense (+1 = counter-clockwise seen from outside). */
export interface ShaftMotion { period: number, sense: 1 | -1, phase: number }

/** The odometer axle: one turn per ten displayed seconds, rolling the drums forward. */
export const AXLE_PERIOD = 10

/**
 * Period, sense and phase of every shaft. Phases make the teeth interleave:
 * gear q's gap is centred on the line of centres exactly when gear p's tooth
 * is, and the relation holds at every g because the angles move in the tooth
 * ratio. Gear tooth 0 sits on its local +x axis; each gear's local frame is
 * its shaft's frame (compound gears share one).
 */
export const MOTION: Record<ShaftId, ShaftMotion> = (() => {
  const out: Partial<Record<ShaftId, ShaftMotion>> = { O: { period: AXLE_PERIOD, sense: 1, phase: 0 } }
  for (const [pId, qId] of MESHES) {
    const p = gear(pId)
    const q = gear(qId)
    const mp = out[p.shaft]!
    const P = SHAFTS[p.shaft]
    const Q = SHAFTS[q.shaft]
    const beta = Math.atan2(Q.y - P.y, Q.x - P.x)
    // At g = 0 gear p's angle is mp.phase. Put q so a gap faces p along the line of centres
    // when a tooth of p does, then carry the ratio.
    const phase = -(p.teeth / q.teeth) * (mp.phase - beta) + beta + Math.PI - Math.PI / q.teeth
    out[q.shaft] = { period: mp.period * q.teeth / p.teeth, sense: (-mp.sense) as 1 | -1, phase }
  }
  return out as Record<ShaftId, ShaftMotion>
})()

const TAU = Math.PI * 2

/**
 * Shaft angle at train coordinate g, reduced in double precision before it
 * ever reaches a float32 matrix (g is millions of seconds; 2*pi*g/10 in
 * float32 would be accurate to half a radian).
 */
export function shaftAngle(id: ShaftId, g: number): number {
  const m = MOTION[id]
  const r = ((g % m.period) + m.period) % m.period
  return m.sense * TAU * r / m.period + m.phase
}

// ── Outlines ──────────────────────────────────────────────────────────────

const inv = (a: number) => Math.tan(a) - a

/**
 * Involute spur gear outline, counter-clockwise, flat [x0, y0, x1, y1, ...],
 * tooth 0 centred on +x. Flanks are true involutes from the base circle to the
 * tip; below the base circle (small pinions) the flank runs radially to the
 * root. No fillets: at drawing scale they are below a pixel.
 */
export function gearOutline(teeth: number, flankSteps = 5): number[] {
  const r = pitchR(teeth)
  const rb = r * Math.cos(PRESSURE)
  const ra = outerR(teeth)
  const rf = rootR(teeth)
  const halfPitch = Math.PI / teeth
  const psiP = halfPitch / 2 - BACKLASH / 2 / r
  const psi = (rho: number) => {
    const a = Math.acos(Math.min(1, rb / Math.max(rho, rb)))
    return psiP + inv(PRESSURE) - inv(a)
  }
  const r0 = Math.max(rb, rf)
  const flank: [number, number][] = []
  if (rf < rb) flank.push([rf, psi(rb)])
  for (let i = 0; i <= flankSteps; i++) {
    // Denser near the tip, where the involute bends most.
    const t = Math.sin((i / flankSteps) * Math.PI / 2)
    const rho = r0 + (ra - r0) * t
    flank.push([rho, psi(rho)])
  }
  const pts: number[] = []
  const at = (rho: number, a: number) => pts.push(rho * Math.cos(a), rho * Math.sin(a))
  for (let k = 0; k < teeth; k++) {
    const c = k * 2 * halfPitch
    const rootHalf = flank[0]![1]
    // Root arc from the previous gap's middle to this tooth's right flank.
    at(rf, c - halfPitch)
    at(rf, c - (halfPitch + rootHalf) / 2)
    for (const [rho, p] of flank) at(rho, c - p)
    const tip = flank[flank.length - 1]![1]
    at(ra, c - tip / 3)
    at(ra, c + tip / 3)
    for (let i = flank.length - 1; i >= 0; i--) at(flank[i]![0], c + flank[i]![1])
    at(rf, c + (halfPitch + rootHalf) / 2)
  }
  return pts
}

// ── Escapement ────────────────────────────────────────────────────────────

/**
 * Graham-style anchor over a 15-tooth escape wheel on shaft X (30 s a turn:
 * one tooth every 2 s, half a tooth per tick). The pallet arms lie along the
 * tangents from the anchor pivot to the pallet circle, so a small swing moves
 * the pallets almost purely radially -- in between the teeth, or clear.
 *
 * The pallets sit ALPHA either side of the top. 2 * ALPHA is an odd number of
 * half-teeth (84 deg = 3.5 x 24 deg), which is what lets one pallet lock on
 * even seconds and the other on odd ones.
 */
export const ESCAPE = {
  teeth: 15,
  ra: 0.085,
  rf: 0.066,
  /** Pallet faces at rest (anchor level) sit this far outside the tooth tips. */
  clearance: 0.008,
  alpha: 42 * Math.PI / 180,
  /** Tick roll: the train moves during the first TICK s of each second. */
  tick: 0.3,
}
export const PALLET_R = ESCAPE.ra + ESCAPE.clearance
/** Anchor pivot above shaft X. */
export const ANCHOR_D = PALLET_R / Math.cos(ESCAPE.alpha)
export const ARM_L = PALLET_R * Math.tan(ESCAPE.alpha)

/** Where a pallet sits in the space after a tooth tip, as a fraction of the pitch (the space is widest there). */
const GAP = 0.4

/**
 * Escape wheel's own tooth offset on shaft X: at even g the right pallet (at
 * 90 - alpha deg) faces the middle of a space; half a tooth later (odd g) the
 * left one does, because the pallets are 3.5 pitches apart.
 */
export const ESCAPE_OFFSET = (() => {
  const pitch = TAU / ESCAPE.teeth
  return Math.PI / 2 - ESCAPE.alpha - MOTION.X.sense * GAP * pitch - MOTION.X.phase
})()

/**
 * Sawtooth escape wheel outline (counter-clockwise), tooth tips at k * pitch.
 * The steep locking face leads in the wheel's direction of travel, so the
 * teeth are mirrored for a clockwise arbor.
 */
export function escapeOutline(): number[] {
  const { teeth, ra, rf } = ESCAPE
  const pitch = TAU / teeth
  const s = MOTION.X.sense
  const pts: number[] = []
  const at = (r: number, a: number) => pts.push(r * Math.cos(a), r * Math.sin(a))
  for (let k = 0; k < teeth; k++) {
    const c = k * pitch
    // Tip, a short land, the locking face down to the root, then the back slope up to the next tip.
    const tooth: [number, number][] = [[ra, 0], [ra, 0.1], [rf, 0.2], [rf, 0.42]]
    if (s > 0) for (const [r, f] of tooth) at(r, c + f * pitch)
    else for (const [r, f] of tooth.reverse()) at(r, c + pitch - f * pitch)
  }
  return pts
}

/** Anchor pivot, straight above the escape arbor. */
export const PIVOT = { x: SHAFTS.X.x, y: SHAFTS.X.y + ANCHOR_D }
/** Pallet nib width across the arm. */
export const PALLET_W = 0.009

/**
 * Inner corners of both pallets in the plate frame for an anchor swing
 * (rad, counter-clockwise): [lx0, ly0, lx1, ly1, rx0, ry0, rx1, ry1]. At zero
 * swing the nibs sit on the pallet circle at the tangent points.
 */
export function palletCorners(swing: number): number[] {
  const out: number[] = []
  const c = Math.cos(swing)
  const s = Math.sin(swing)
  for (const side of [1, -1]) {
    const a = Math.PI / 2 + side * ESCAPE.alpha
    const tx = SHAFTS.X.x + PALLET_R * Math.cos(a)
    const ty = SHAFTS.X.y + PALLET_R * Math.sin(a)
    const ux = (tx - PIVOT.x) / ARM_L
    const uy = (ty - PIVOT.y) / ARM_L
    for (const k of [-0.5, 0.5]) {
      const x = tx + ux * PALLET_W * k - PIVOT.x
      const y = ty + uy * PALLET_W * k - PIVOT.y
      out.push(PIVOT.x + x * c - y * s, PIVOT.y + x * s + y * c)
    }
  }
  return out
}

/**
 * Swing amplitude, solved on the real pallet geometry: the deepest pallet
 * corner reaches the tooth-tip circle (less half a millimetre) exactly when
 * the swing is at sin(pi * TICK / 2) of its amplitude -- i.e. at the edges of
 * the tick window -- so the wheel only ever turns while both pallets are clear.
 */
export const SWING = (() => {
  const reach = (d: number) => {
    const c = palletCorners(d)
    let m = Infinity
    for (let k = 0; k < c.length; k += 2) m = Math.min(m, Math.hypot(c[k]! - SHAFTS.X.x, c[k + 1]! - SHAFTS.X.y))
    return m
  }
  let lo = 0
  let hi = 0.5
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (reach(mid) > ESCAPE.ra + 0.0005) lo = mid
    else hi = mid
  }
  return lo / Math.sin(Math.PI * ESCAPE.tick / 2)
})()

// ── Geometry helpers for the tests ────────────────────────────────────────

/** Outline points transformed to the plate frame: rotated by `angle`, moved to (cx, cy). */
export function place(outline: number[], angle: number, cx: number, cy: number): number[] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const out = new Array<number>(outline.length)
  for (let i = 0; i < outline.length; i += 2) {
    const x = outline[i]!
    const y = outline[i + 1]!
    out[i] = cx + x * c - y * s
    out[i + 1] = cy + x * s + y * c
  }
  return out
}

/** Even-odd point-in-polygon. */
export function inside(poly: number[], x: number, y: number): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i]!
    const yi = poly[i + 1]!
    const xj = poly[j]!
    const yj = poly[j + 1]!
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}
