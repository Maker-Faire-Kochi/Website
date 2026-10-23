/**
 * Fixed-step clock. Every simulation on the stage advances in identical 5ms
 * steps, so a robot behaves the same at 30, 60 or 144Hz: the frame rate only
 * decides how many steps run per frame, never how big a step is.
 *
 * A long gap (background tab, offscreen, a paused stage) is clamped to
 * MAX_FRAME of simulated time and the rest is dropped -- counted in `dropped`
 * for debugging -- so nothing ever fast-forwards through seconds of motion.
 */
export const DT = 1 / 200
const MAX_FRAME = 0.1
const MAX_STEPS = 20
const EPS = 1e-9

export class FixedClock {
  private last: number | null = null
  private acc = 0
  dropped = 0

  /** Runs `step` zero or more times and returns the interpolation alpha in [0, 1). */
  advance(nowMs: number, step: () => void): number {
    if (this.last === null) {
      this.last = nowMs
      return 0
    }
    let frame = (nowMs - this.last) / 1000
    this.last = nowMs
    if (frame > MAX_FRAME) {
      this.dropped += Math.floor((frame - MAX_FRAME) / DT)
      frame = MAX_FRAME
    }
    this.acc += Math.max(0, frame)
    let n = 0
    // EPS absorbs float drift: 0.1 s summed in DT steps is 19.999..., which
    // would otherwise run one step short and carry a near-DT remainder.
    while (this.acc >= DT - EPS && n < MAX_STEPS) {
      step()
      this.acc = Math.max(0, this.acc - DT)
      n++
    }
    if (this.acc >= DT - EPS) {
      this.dropped += Math.floor(this.acc / DT)
      this.acc %= DT
    }
    return this.acc / DT
  }

  /** The next advance() runs no steps; it only re-anchors the clock. */
  reset() {
    this.last = null
    this.acc = 0
  }
}
