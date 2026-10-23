import { rng, type Rng } from '../../core/rng'

/**
 * The pen plotter, as pure kinematics. Coordinates are the plotter's own
 * frame in metres: x across the bed, z toward the viewer, origin at the bed
 * centre. The pen tip IS the plotted point: the carriage rides the bridge at
 * pen x, the bridge rides the rails at pen z, and while the pen is down every
 * step appends exactly the tip's position to the sheet's line buffer.
 *
 * The drawing is a two-pendulum harmonograph: a sum of damped sines per axis.
 * Its amplitudes sum to at most 1 (plus a small wiggle term, also counted),
 * so the figure can never leave the drawable area, whatever the frequencies do.
 * While the synth plays, its pitch bends one frequency ratio and its level
 * adds a fast wiggle: the music is written into the drawing.
 */

export const PAPER = { w: 0.29, d: 0.205, cz: 0.015 }
/** Drawable half extents around the paper centre (2 cm margins). */
export const AREA = { hx: 0.125, hz: 0.085 }
/** Where the pen waits, up, clear of the paper's left edge. */
export const PARK = { x: -0.15, z: -0.1 }
/** Points per sheet; a drawing stores one per 5 ms step while the pen is down. */
export const CAP = 6000
export const DRAW_S = 24
/** Distance a sheet travels when fed in from the back or pushed off the front. */
export const FEED = 0.24
export const SWAP_S = 1.6
const LIFT_S = 0.12
const REST_S = 0.6
/** Gantry speed for pen-up moves (m/s); the move eases in and out. */
const TRAVEL_V = 0.22
/** The largest wiggle the music can add (in normalised units). */
export const WIGGLE_MAX = 0.05
const A1 = 0.56
const A2 = 0.38
const OMEGA = 2 * Math.PI * 0.11
const WIGGLE_HZ = 2.2

export type PlotPhase = 'swap' | 'travel' | 'lower' | 'draw' | 'raise' | 'return' | 'rest'

/** What the synth feeds the drawing each step. */
export interface PlotInput { pitch01: number, active: boolean, level: number }

interface Harmonograph {
  r: [number, number, number, number]
  phase0: [number, number, number, number]
  d1: number
  d2: number
}

const smooth = (t: number) => {
  const s = t < 0 ? 0 : t > 1 ? 1 : t
  return s * s * (3 - 2 * s)
}

function params(r: Rng): Harmonograph {
  const pick = (set: number[]) => set[Math.floor(r.next() * set.length)]!
  const detune = () => 1 + r.range(-0.012, 0.012)
  const rx1 = pick([2, 3])
  const ry1 = pick([2, 3])
  return {
    // x1, y1: the main pendulum; x2, y2: the second, at another small ratio.
    r: [rx1 * detune(), ry1 * detune(), pick([1, 2, 3, 4]) * detune(), pick([1, 2, 3]) * detune()],
    phase0: [r.range(0, Math.PI * 2), r.range(0, Math.PI * 2), r.range(0, Math.PI * 2), r.range(0, Math.PI * 2)],
    d1: r.range(0.04, 0.07),
    d2: r.range(0.02, 0.06),
  }
}

export class Plotter {
  phase: PlotPhase = 'swap'
  /** Seconds spent in the current phase. */
  t = 0
  pen = { x: PARK.x, z: PARK.z, lift: 1 }
  /** Sheet slide offset (z) and opacity, for the two sheets that take turns. */
  sheets = [{ off: -FEED, op: 0 }, { off: FEED, op: 0 }]
  /** The sheet being drawn on. */
  cur = 1
  /** x,z pairs in plotter coordinates (the sheet's own frame while it is drawn on). */
  buf = [new Float32Array(CAP * 2), new Float32Array(CAP * 2)]
  count = [0, 0]
  /** Sheets started so far; bumps whenever count[cur] is reset. */
  sheetNo = 0
  private rand: Rng
  private h!: Harmonograph
  private phi = [0, 0, 0, 0]
  private wPhi = 0
  private tau = 0
  private nudge = 0
  private wiggle = 0
  private from = { x: 0, z: 0, lift: 0, dur: 1 }
  private to = { x: 0, z: 0 }
  private swapFrom = [{ off: 0, op: 0 }, { off: 0, op: 0 }]

  constructor(seed: number) {
    this.rand = rng(seed)
    this.beginSwap()
  }

  /** The solenoid holds the pen up: it is energised whenever the pen is not down. */
  get solenoid() {
    return this.pen.lift > 0
  }

  get penDown() {
    return this.pen.lift === 0
  }

  /** 0..1 progress through the drawing. */
  get progress() {
    return this.phase === 'draw' ? this.tau / DRAW_S : this.phase === 'raise' || this.phase === 'return' || this.phase === 'rest' ? 1 : 0
  }

  /** Finish this drawing now and start a fresh sheet. */
  restart(): 'started' | 'busy' {
    if (this.phase === 'travel' || this.phase === 'lower' || this.phase === 'draw') {
      this.begin('raise')
      return 'started'
    }
    return 'busy'
  }

  step(dt: number, input: PlotInput) {
    this.t += dt
    switch (this.phase) {
      case 'swap': {
        const s = smooth(this.t / SWAP_S)
        const old = this.cur ^ 1
        const a = this.sheets[old]!
        const b = this.sheets[this.cur]!
        a.off = this.swapFrom[old]!.off + (FEED - this.swapFrom[old]!.off) * s
        a.op = this.swapFrom[old]!.op * (1 - s)
        b.off = -FEED * (1 - s)
        b.op = s
        if (this.t >= SWAP_S) this.beginTravel(this.point())
        break
      }
      case 'travel':
      case 'return': {
        const s = smooth(this.t / this.from.dur)
        this.pen.x = this.from.x + (this.to.x - this.from.x) * s
        this.pen.z = this.from.z + (this.to.z - this.from.z) * s
        if (this.t >= this.from.dur) {
          this.pen.x = this.to.x
          this.pen.z = this.to.z
          this.begin(this.phase === 'travel' ? 'lower' : 'rest')
        }
        break
      }
      case 'lower': {
        this.pen.lift = this.t >= LIFT_S ? 0 : this.from.lift * (1 - smooth(this.t / LIFT_S))
        if (this.pen.lift === 0) {
          this.begin('draw')
          this.append()
        }
        break
      }
      case 'draw': {
        this.advance(dt, input)
        const p = this.point()
        this.pen.x = p.x
        this.pen.z = p.z
        this.append()
        if (this.tau >= DRAW_S || this.count[this.cur]! >= CAP) this.begin('raise')
        break
      }
      case 'raise': {
        this.pen.lift = this.t >= LIFT_S ? 1 : this.from.lift + (1 - this.from.lift) * smooth(this.t / LIFT_S)
        if (this.pen.lift === 1) {
          this.to = { x: PARK.x, z: PARK.z }
          this.from = { x: this.pen.x, z: this.pen.z, lift: 1, dur: this.travelTime() }
          this.begin('return')
        }
        break
      }
      case 'rest':
        if (this.t >= REST_S) this.beginSwap()
        break
    }
  }

  private begin(p: PlotPhase) {
    this.phase = p
    this.t = 0
    this.from.lift = this.pen.lift
  }

  private beginSwap() {
    this.cur ^= 1
    this.count[this.cur] = 0
    this.sheetNo++
    this.swapFrom = this.sheets.map(s => ({ ...s }))
    this.h = params(this.rand)
    this.phi = [...this.h.phase0]
    this.wPhi = 0
    this.tau = 0
    this.wiggle = 0
    this.begin('swap')
  }

  private beginTravel(target: { x: number, z: number }) {
    this.to = { x: target.x, z: target.z }
    this.from = { x: this.pen.x, z: this.pen.z, lift: this.pen.lift, dur: this.travelTime() }
    this.begin('travel')
  }

  private travelTime() {
    return Math.max(0.35, Math.hypot(this.to.x - this.pen.x, this.to.z - this.pen.z) / TRAVEL_V)
  }

  private advance(dt: number, input: PlotInput) {
    // Ease toward the music's influence so a note change bends the line, never kinks it.
    const nudgeTarget = input.active ? 0.12 * (input.pitch01 - 0.5) : 0
    this.nudge += (nudgeTarget - this.nudge) * (1 - Math.exp(-dt / 0.4))
    const wigTarget = WIGGLE_MAX * 0.9 * Math.max(0, Math.min(1, input.level))
    this.wiggle += (wigTarget - this.wiggle) * (1 - Math.exp(-dt / 0.15))
    const r = this.h.r
    this.phi[0]! += OMEGA * r[0] * dt
    this.phi[1]! += OMEGA * r[1] * dt
    this.phi[2]! += OMEGA * (r[2] + this.nudge) * dt
    this.phi[3]! += OMEGA * (r[3] - this.nudge * 0.5) * dt
    this.wPhi += 2 * Math.PI * WIGGLE_HZ * dt
    this.tau += dt
  }

  /** The harmonograph's current point, in plotter coordinates. */
  private point() {
    const e1 = Math.exp(-this.h.d1 * this.tau)
    const e2 = Math.exp(-this.h.d2 * this.tau)
    const u = A1 * Math.sin(this.phi[0]!) * e1 + A2 * Math.sin(this.phi[2]!) * e2 + this.wiggle * Math.sin(this.wPhi)
    const v = A1 * Math.sin(this.phi[1]!) * e1 + A2 * Math.sin(this.phi[3]!) * e2 + this.wiggle * Math.cos(this.wPhi)
    return { x: u * AREA.hx, z: PAPER.cz + v * AREA.hz }
  }

  private append() {
    const c = this.count[this.cur]!
    if (c >= CAP) return
    const b = this.buf[this.cur]!
    b[c * 2] = this.pen.x
    b[c * 2 + 1] = this.pen.z
    this.count[this.cur] = c + 1
  }
}
