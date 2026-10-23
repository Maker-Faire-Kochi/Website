import { workToWorld, type V3 } from './bench-layout'
import { BB, SBC } from './layout'

/**
 * Scroll-driven camera shots. The page pins the workbench band while the
 * visitor scrolls through SHOTS and writes `scrollShot.progress` (0 = the
 * whole bench, SHOTS.length - 1 = the last detail, fractions in between); the
 * DOM shows each shot's title and note beside the drawing. When the band is
 * not pinned the DOM leaves progress at 0.
 *
 * The scene eases a smoothed progress toward that input with a critically
 * damped spring that is clamped so it never overshoots, and frames the camera
 * from the smoothed value: target, view height and a slight orbit, blended
 * between neighbouring shots (never cut). View height is blended
 * geometrically, so a zoom reads as an even push-in, and is monotone between
 * any two neighbours. Pure: the tests and a poster renderer use the same math.
 */

export interface Shot {
  id: 'bench' | 'iron' | 'board' | 'breadboard'
  title: string
  note: string
}

export const SHOTS: Shot[] = [
  { id: 'bench', title: 'The bench', note: 'A maker\'s electronics bench: tools along the top, a silicone mat in front where the small work happens.' },
  { id: 'iron', title: 'Soldering iron', note: 'A temperature-controlled iron melts solder into each joint, joining a part\'s lead to the copper pad.' },
  { id: 'board', title: 'Single-board computer', note: 'A credit-card-sized computer whose 40-pin header switches the LEDs, reads the button and drives the servo.' },
  { id: 'breadboard', title: 'Breadboard', note: 'Holes connected in strips let parts be wired up and changed without any solder.' },
]

/** The page's input, written by the DOM. Not reactive on purpose: the scene reads it every step. */
export const scrollShot = { progress: 0 }

export interface Framing { target: V3, viewH: number, az: number, el: number }

/**
 * Detail shots: a fixed target, view height (metres) and camera angles
 * (azimuth from the front toward +x, elevation; radians). They look down from
 * high on the maker's LEFT, past his shoulder, so his head and arms never
 * stand between the camera and the part; the iron shot is wide enough to
 * hold both his hands at work.
 */
const sbcC = workToWorld((SBC.x0 + SBC.x1) / 2, SBC.y + 0.1, (SBC.z0 + SBC.z1) / 2)
const bbC = workToWorld((BB.x0 + BB.x1) / 2, BB.h, (BB.z0 + BB.z1) / 2)
/**
 * The iron shot looks in LOW from the maker's left, under the line of his
 * bent head (he looks down at the joint, so any view from above puts his head
 * over the work): the joint in the middle, the solder wire rising to it from
 * his left hand on the mat, the iron crossing the frame to his right hand,
 * and his head only at the top edge.
 */
const ironC: V3 = [-0.1, 0.92, 0.17]

export const DETAIL: Record<Exclude<Shot['id'], 'bench'>, { target: V3, viewH: number, az: number, el: number }> = {
  iron: { target: ironC, viewH: 0.55, az: -1.0, el: 0.4 },
  board: { target: sbcC, viewH: 0.17, az: -0.2, el: 1.32 },
  breadboard: { target: bbC, viewH: 0.2, az: -0.15, el: 1.25 },
}

export const SHOT_MAX = SHOTS.length - 1

export function clampProgress(p: number) {
  if (!Number.isFinite(p)) return 0
  return Math.min(SHOT_MAX, Math.max(0, p))
}

function shotFraming(i: number, bench: Framing, out: Framing): Framing {
  const s = SHOTS[i]!
  if (s.id === 'bench') {
    out.target[0] = bench.target[0]
    out.target[1] = bench.target[1]
    out.target[2] = bench.target[2]
    out.viewH = bench.viewH
    out.az = bench.az
    out.el = bench.el
    return out
  }
  const d = DETAIL[s.id]
  out.target[0] = d.target[0]
  out.target[1] = d.target[1]
  out.target[2] = d.target[2]
  out.viewH = d.viewH
  out.az = d.az
  out.el = d.el
  return out
}

export function newFraming(): Framing {
  return { target: [0, 0, 0], viewH: 1, az: 0, el: 0 }
}

const fa = newFraming()
const fb = newFraming()

/**
 * Framing at progress p, given the whole-bench framing (which depends on the
 * slot's aspect). Between shots i and i + 1 the blend weight is a smoothstep
 * of the fraction, so the camera has no speed at a shot.
 */
export function framingAt(p: number, bench: Framing, out: Framing = newFraming()): Framing {
  const q = clampProgress(p)
  const i = Math.min(SHOT_MAX - 1, Math.floor(q))
  const f = q - i
  if (SHOT_MAX === 0) return shotFraming(0, bench, out)
  if (f === 0) return shotFraming(i, bench, out)
  if (f === 1) return shotFraming(i + 1, bench, out)
  shotFraming(i, bench, fa)
  shotFraming(i + 1, bench, fb)
  const w = f * f * (3 - 2 * f)
  for (let k = 0; k < 3; k++) out.target[k] = fa.target[k]! + (fb.target[k]! - fa.target[k]!) * w
  out.viewH = Math.exp(Math.log(fa.viewH) + (Math.log(fb.viewH) - Math.log(fa.viewH)) * w)
  out.az = fa.az + (fb.az - fa.az) * w
  out.el = fa.el + (fb.el - fa.el) * w
  return out
}

/** Spring stiffness (1/s): about 0.8 s to settle across one shot. */
export const SHOT_OMEGA = 6
/**
 * Arrival: settling within ARRIVE of a shot, moving slower than SETTLED
 * (progress per second), fires its action once; scrolling straight past a
 * shot does not. Leaving it by REARM re-arms it.
 */
export const ARRIVE = 0.02
export const SETTLED = 0.3
export const REARM = 0.5

/**
 * The eased progress the camera follows, and the once-per-arrival trigger.
 * Step it at the fixed DT: frame-rate independent and deterministic.
 */
export class ShotFollower {
  s = 0
  v = 0
  private readonly armed: boolean[] = SHOTS.map(() => true)

  /** Advance toward `input`; returns the index of a shot just arrived at, or -1. */
  step(dt: number, input: number): number {
    const x = clampProgress(input)
    const e0 = x - this.s
    const w = SHOT_OMEGA
    this.v += (w * w * e0 - 2 * w * this.v) * dt
    this.s += this.v * dt
    const e1 = x - this.s
    // Critically damped can still cross the goal when it starts with speed
    // toward it; clamp at the goal so the camera never swings past a shot.
    if (e0 === 0 || Math.sign(e1) !== Math.sign(e0) || Math.abs(e1) < 1e-6) {
      this.s = x
      this.v = 0
    }
    let arrived = -1
    for (let i = 0; i < SHOTS.length; i++) {
      const d = Math.abs(this.s - i)
      if (d > REARM) this.armed[i] = true
      else if (d < ARRIVE && Math.abs(this.v) < SETTLED && this.armed[i]) {
        this.armed[i] = false
        if (i > 0) arrived = i
      }
    }
    return arrived
  }

  /** The shot the camera is at or nearest, and how settled on it (1 = there). */
  get nearest() {
    return Math.round(this.s)
  }

  /** Snap without easing (posters, first frame). */
  jump(input: number) {
    this.s = clampProgress(input)
    this.v = 0
    for (let i = 0; i < SHOTS.length; i++) this.armed[i] = Math.abs(this.s - i) > ARRIVE
  }
}
