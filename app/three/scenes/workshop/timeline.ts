/**
 * Who works when. One tool at a time, in a calm loop -- saw, plane, chisel,
 * then a longer rest while the stool takes itself apart -- and a tap queues a
 * tool to run next instead of interrupting the one at work. Pure, stepped at
 * the stage's fixed DT, so the loop replays identically.
 */

import { SAW } from './layout'

export type Tool = 'saw' | 'plane' | 'chisel'
export const ORDER: Tool[] = ['saw', 'plane', 'chisel']

/**
 * The phases of each action, in order, with their lengths (s). The
 * carpenter's hand travels to the resting tool first (reach: nothing moves),
 * so a tool never moves until a hand is on it. The saw is picked up by the
 * left hand and passed to the right (pass), set into the cut (place), and
 * passed back the same way; the plane is carried by the left hand and set on
 * the board while the right takes the tote (set). Static phases (reach, pass,
 * set, unpass) are where the carpenter may hold the clock until a hand has
 * settled; the tools never move during them.
 */
export type PhaseName = 'reach' | 'fetch' | 'pass' | 'place' | 'set' | 'work' | 'unset' | 'lift' | 'unpass' | 'return'
export const REACH = 0.5
export const BLOW = 0.8
export const BLOWS = 3
export const PHASES: Record<Tool, readonly (readonly [PhaseName, number])[]> = {
  saw: [['reach', REACH], ['fetch', 0.6], ['pass', 0.45], ['place', 0.45], ['work', SAW.strokes * SAW.period],
    ['lift', 0.45], ['unpass', 0.45], ['return', 0.6]],
  plane: [['reach', REACH], ['fetch', 0.8], ['set', 0.45], ['work', 2.2], ['unset', 0.3], ['return', 0.8]],
  chisel: [['reach', REACH], ['fetch', 0.8], ['work', BLOWS * BLOW], ['return', 0.8]],
}
export const STATIC: ReadonlySet<PhaseName> = new Set(['reach', 'pass', 'set', 'unset', 'unpass'])

/** Seconds per action, the sum of its phases. */
export const DURATION = Object.fromEntries(
  (Object.keys(PHASES) as Tool[]).map(k => [k, PHASES[k].reduce((a, p) => a + p[1], 0)]),
) as Record<Tool, number>

/** Start time of a phase within its action. */
export function phaseStart(tool: Tool, name: PhaseName) {
  let t = 0
  for (const [n, d] of PHASES[tool]) {
    if (n === name) return t
    t += d
  }
  return t
}

/** Phase at time t into an action: its name, the time into it, its length. */
export function phaseOf(tool: Tool, t: number): { name: PhaseName, t: number, len: number } {
  const list = PHASES[tool]
  let t0 = 0
  for (const [n, d] of list) {
    if (t < t0 + d) return { name: n, t: t - t0, len: d }
    t0 += d
  }
  const [n, d] = list[list.length - 1]!
  return { name: n, t: d, len: d }
}

/** Breath between automatic actions. */
export const GAP = 1.4
/** After the chisel: long enough for the stool to explode, hold and close again. */
export const STOOL_GAP = 5.6
/** A queued tap follows the previous action almost at once. */
export const QUEUE_GAP = 0.3
export const FIRST_WAIT = 0.6
export const MAX_QUEUE = 3

export interface TimelineStep {
  /** Tool that started this step (its time is 0 now), if any. */
  started: Tool | null
  /** Tool that finished this step, if any. */
  ended: Tool | null
  /** The automatic loop wrapped: the stool's turn. */
  stool: boolean
}

export class Timeline {
  current: Tool | null = null
  /** Time into the current action. */
  t = 0
  /** Time left before the next action starts, while idle. */
  wait = FIRST_WAIT
  queue: Tool[] = []
  private next = 0
  private auto = false
  private readonly out: TimelineStep = { started: null, ended: null, stool: false }

  /**
   * `hold` stops the clock for this step (the carpenter is walking to the
   * bench, waving, or still settling a hand on the tool): nothing starts,
   * nothing advances.
   */
  step(dt: number, hold = false): TimelineStep {
    const out = this.out
    out.started = out.ended = null
    out.stool = false
    if (hold) return out
    if (this.current) {
      this.t += dt
      if (this.t >= DURATION[this.current]) {
        out.ended = this.current
        out.stool = this.auto && this.current === 'chisel'
        this.current = null
        this.wait = this.queue.length ? QUEUE_GAP : out.stool ? STOOL_GAP : GAP
      }
      return out
    }
    this.wait -= dt
    if (this.wait <= 0) {
      const queued = this.queue.shift()
      if (queued) this.begin(queued, false)
      else {
        this.begin(ORDER[this.next]!, true)
        this.next = (this.next + 1) % ORDER.length
      }
      out.started = this.current
    }
    return out
  }

  /** A tap or key: run now if idle, otherwise queue behind the current action. */
  request(tool: Tool): 'started' | 'queued' | 'full' {
    if (!this.current) {
      this.begin(tool, false)
      return 'started'
    }
    if (this.queue.length >= MAX_QUEUE) return 'full'
    this.queue.push(tool)
    return 'queued'
  }

  clearQueue() {
    this.queue.length = 0
  }

  /** The tool at work, or the one that will run next (queued first, then the loop). */
  get upcoming(): Tool {
    return this.current ?? this.queue[0] ?? ORDER[this.next]!
  }

  /** Back to the start of the current action's reach (the tools are still at rest then). */
  restartReach() {
    if (this.current && this.t < REACH) this.t = 0
  }

  private begin(tool: Tool, auto: boolean) {
    this.current = tool
    this.auto = auto
    this.t = 0
  }
}
