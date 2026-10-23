import { ESCAPE, MOTION, SWING } from './gears'

/**
 * The machine room as plain numbers: real time in, one train coordinate and
 * one counter reading out, advanced in fixed steps. The renderer only reads
 * snapshot(), so the tests drive exactly the motion the page draws.
 *
 * Two quantities, kept apart on purpose:
 *  - rem, the true seconds left to the event (from the clock), and
 *  - lead, how far the crank has wound the counter AHEAD of it (>= 0).
 * The counter shows rem - lead; with the crank at rest lead is exactly 0, so
 * the counter can only ever be wrong while somebody is visibly winding it.
 * Lead never goes negative: the crank has a ratchet, and winding backwards
 * stops at the true time -- the counter never shows more time left than
 * there is.
 *
 * The train ticks like the clock it is: in each second it moves during the
 * first ESCAPE.tick s (eased, zero velocity at both ends) and stands still
 * for the rest, locked by the escapement. Every gear and the seconds drum
 * hang off one coordinate g, so they cannot disagree.
 */

export const CRANK_PERIOD = MOTION.K.period
/** The scripted crank: three turns, eased, a held beat, then the ease back. */
export const SCRIPT = { turns: 3, time: 2.4, hold: 0.5 }
/** A clock this far off the simulated one is re-read rather than chased (tab was hidden, steps dropped). */
const RESYNC_MS = 400
/** How far ahead the crank may wind, in seconds of display. */
const MAX_LEAD = 12 * 3600
/** Below the event, it may still spin the (then disengaged) train this much. */
const SPIN_LEAD = 600

export type Mode = 'idle' | 'drag' | 'script' | 'return'
export type Phase = 'upcoming' | 'live' | 'ended'

/** Snapshot layout: every scalar the renderer interpolates between steps. */
export const SNAP = { g: 0, count: 1, swing: 2, size: 3 } as const
/** Bit flags set by the step that produced them. */
export const EV = { TICK: 1, RELEASE: 2, RATCHET: 4 } as const

const smoother = (v: number) => {
  const x = v < 0 ? 0 : v > 1 ? 1 : v
  return x * x * x * (x * (x * 6 - 15) + 10)
}

/**
 * Tick-eased countdown: whole seconds left (floor, like useCountdown), rolled
 * from the previous whole second over the first `tick` s after each boundary.
 * Exactly an integer for the rest of every second.
 */
export function tickEased(rem: number, tick = ESCAPE.tick): number {
  const k = Math.floor(rem)
  const e = k + 1 - rem
  return k + 1 - smoother(e / tick)
}

export interface SimOptions {
  startMs: number
  endMs: number
  /** Wall clock in ms; the sim re-anchors to it when they drift apart. */
  now: () => number
}

export class MachineSim {
  readonly startMs: number
  readonly endMs: number
  private now: () => number
  /** Simulated wall clock, ms. */
  simMs: number
  lead = 0
  mode: Mode = 'idle'
  /** 0..1: how far the escapement is held clear of the escape wheel (it is while the crank winds). */
  hold = 0
  /** Lead change rate, display seconds per second: the crank's speed for the whirr. */
  speed = 0
  /** Events raised by the last step (EV bit flags). */
  events = 0
  /** The last step re-read the wall clock and jumped: do not interpolate across it. */
  jumped = false
  private target = 0
  private tau = 0
  private from = 0
  private dur = 0
  private whole: number

  constructor(o: SimOptions) {
    this.startMs = o.startMs
    this.endMs = o.endMs
    this.now = o.now
    this.simMs = o.now()
    this.whole = Math.floor(this.rem())
  }

  /** True seconds left, frozen at the event's end (the train stops there). */
  rem(): number {
    return Math.max((this.startMs - this.simMs) / 1000, (this.startMs - this.endMs) / 1000)
  }

  phase(): Phase {
    if (this.simMs >= this.endMs) return 'ended'
    return this.simMs >= this.startMs ? 'live' : 'upcoming'
  }

  /** Displayed count with the crank at rest: tick-eased whole seconds left. */
  trueCount(): number {
    return tickEased(this.rem())
  }

  /** What the counter shows: never below zero, never more than the true count. */
  count(): number {
    return Math.max(0, this.trueCount() - this.lead)
  }

  /** The train coordinate: rises one unit per displayed second. */
  train(): number {
    return this.lead - this.trueCount()
  }

  private maxLead() {
    return Math.min(MAX_LEAD, Math.max(this.trueCount(), SPIN_LEAD))
  }

  // ── Input ─────────────────────────────────────────────────────────────

  beginDrag() {
    this.mode = 'drag'
    this.target = this.lead
  }

  /** The crank was turned by dPhi rad (counter-clockwise seen from outside). */
  dragBy(dPhi: number) {
    if (this.mode !== 'drag') return
    const next = this.target + MOTION.K.sense * dPhi * CRANK_PERIOD / (2 * Math.PI)
    if (next < 0 && this.target > 0) this.events |= EV.RATCHET
    this.target = Math.min(this.maxLead(), Math.max(0, next))
  }

  endDrag() {
    if (this.mode !== 'drag') return
    if (this.lead > 1e-6 || this.target > 1e-6) {
      this.lead = Math.max(this.lead, this.target)
      this.startReturn()
    }
    else {
      this.lead = 0
      this.mode = 'idle'
    }
  }

  /** Three scripted turns, then back. Returns false if the visitor is already winding. */
  crank(): boolean {
    if (this.mode === 'drag') return false
    this.mode = 'script'
    this.from = this.lead
    this.tau = 0
    return true
  }

  /** Let go and roll back to the true time. Returns false if it already shows it. */
  reset(): boolean {
    if (this.mode === 'drag') this.endDrag()
    else if (this.lead > 0 && this.mode !== 'return') this.startReturn()
    return this.lead > 0
  }

  /** Paused: drop everything and show the true time at once. */
  stop() {
    this.mode = 'idle'
    this.lead = 0
    this.target = 0
    this.hold = 0
    this.speed = 0
  }

  private startReturn() {
    this.mode = 'return'
    this.from = this.lead
    this.tau = 0
    // Longer winds take a little longer to unwind, but never long.
    this.dur = Math.min(2.6, 0.9 + 0.3 * Math.log2(1 + this.from / 60))
    this.events |= EV.RELEASE
  }

  // ── Step ──────────────────────────────────────────────────────────────

  step(dt: number) {
    this.jumped = false
    this.simMs += dt * 1000
    const real = this.now()
    if (Math.abs(real - this.simMs) > RESYNC_MS) {
      this.simMs = real
      this.jumped = true
    }
    const before = this.lead
    switch (this.mode) {
      case 'drag':
        // A stiff follow of the hand: it smooths pointer jitter without lagging visibly.
        this.lead += (this.target - this.lead) * Math.min(1, dt * 25)
        break
      case 'script': {
        this.tau += dt
        const goal = this.from + SCRIPT.turns * CRANK_PERIOD * smoother(this.tau / SCRIPT.time)
        this.lead = Math.min(this.maxLead(), goal)
        if (this.tau >= SCRIPT.time + SCRIPT.hold) this.startReturn()
        break
      }
      case 'return':
        this.tau += dt
        this.lead = this.from * (1 - smoother(this.tau / this.dur))
        if (this.tau >= this.dur) {
          this.lead = 0
          this.mode = 'idle'
        }
        break
    }
    this.lead = Math.min(this.maxLead(), Math.max(0, this.lead))
    this.speed = this.jumped ? 0 : (this.lead - before) / dt

    const held = this.mode !== 'idle' ? 1 : 0
    this.hold += (held - this.hold) * Math.min(1, dt * 10)
    if (!held && this.hold < 1e-4) this.hold = 0

    const whole = Math.floor(this.rem())
    if (whole !== this.whole && this.mode === 'idle' && this.phase() !== 'ended' && !this.jumped) this.events |= EV.TICK
    this.whole = whole
  }

  /** Escapement swing (rad): a steady 2 s beat, crossing level mid-tick, quieted while held clear. */
  swing(): number {
    const p = -this.rem() - ESCAPE.tick / 2
    // Reduce before multiplying by pi: rem is millions of seconds.
    const r = ((p % 2) + 2) % 2
    return SWING * (1 - this.hold) * Math.sin(Math.PI * r)
  }

  snapshot(out: Float64Array) {
    out[SNAP.g] = this.train()
    out[SNAP.count] = this.count()
    out[SNAP.swing] = this.swing()
    return out
  }

  /** Consumes and returns the events raised since the last call. */
  takeEvents(): number {
    const e = this.events
    this.events = 0
    return e
  }
}
