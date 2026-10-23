import { rng } from './rng'

/**
 * WebAudio building blocks shared by every scene's voices (each scene folder's
 * sound.ts): envelopes, filters, seeded noise, tones, one-shot pools (Shots)
 * and self-stopping continuous voices (Drone).
 *
 * None of these create an AudioContext: callers get one from soundContext()
 * (usePanelSound) per sound and play nothing on null. A Drone re-arms its own
 * fade a quarter-second ahead on every update, so if frames stop -- slot
 * scrolled away, tab hidden, motion paused -- it dies out by itself.
 */

export const PEAK = 0.25
/** A continuous voice fades out this long after its last update. */
const WATCHDOG = 0.25
/** Seconds of noise: long enough that a looped source never buzzes at its loop rate. */
const NOISE_SECONDS = 2

const noiseCache = new WeakMap<AudioContext, AudioBuffer>()

/** Seeded white noise in the shared context (built once per context). */
export function longNoise(ac: AudioContext): AudioBuffer {
  let b = noiseCache.get(ac)
  if (!b) {
    b = ac.createBuffer(1, Math.floor(ac.sampleRate * NOISE_SECONDS), ac.sampleRate)
    const r = rng(9001)
    const d = b.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = r.next() * 2 - 1
    noiseCache.set(ac, b)
  }
  return b
}

/** Freeze a param at its current value from t (Firefox lacks cancelAndHoldAtTime). */
export function hold(p: AudioParam, t: number) {
  const q = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam }
  if (q.cancelAndHoldAtTime) q.cancelAndHoldAtTime(t)
  else {
    p.cancelScheduledValues(t)
    p.setValueAtTime(p.value, t)
  }
}

/** Attack to `peak`, exponential decay: the envelope of every one-shot. */
export function envelope(g: GainNode, t: number, peak: number, attack: number, decay: number) {
  const v = Math.max(2e-4, Math.min(PEAK, peak))
  g.gain.setValueAtTime(1e-4, t)
  g.gain.exponentialRampToValueAtTime(v, t + attack)
  g.gain.exponentialRampToValueAtTime(1e-4, t + attack + decay)
}

export function filter(ac: AudioContext, type: BiquadFilterType, freq: number, q = 0.7) {
  const f = ac.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  return f
}

/** A slice of the noise buffer from a varying offset (so repeats never sound identical). */
export function noiseSource(ac: AudioContext, t: number, dur: number, at: number, loop = false) {
  const s = ac.createBufferSource()
  const buf = longNoise(ac)
  s.buffer = buf
  s.loop = loop
  if (loop) s.start(t, at * (buf.duration - 0.1))
  else {
    s.start(t, at * Math.max(0, buf.duration - dur - 0.1))
    s.stop(t + dur + 0.05)
  }
  return s
}

export function tone(ac: AudioContext, type: OscillatorType, t: number, f0: number, f1: number, glide: number, dur: number) {
  const o = ac.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(f0, t)
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glide)
  o.start(t)
  o.stop(t + dur + 0.05)
  return o
}

/** One-shot output stages still sounding, so a pause can fade them at once. */
export class Shots {
  private live: { g: GainNode, end: number }[] = []

  /** A new output stage straight to the speakers, alive until `end`. */
  out(ac: AudioContext, end: number): GainNode {
    const now = ac.currentTime
    this.live = this.live.filter(s => s.end > now)
    const g = ac.createGain()
    g.gain.value = 0
    g.connect(ac.destination)
    this.live.push({ g, end })
    return g
  }

  silence() {
    for (const { g } of this.live) {
      const t = g.context.currentTime
      hold(g.gain, t)
      g.gain.setTargetAtTime(0, t, 0.02)
    }
    this.live = []
  }
}

export interface DroneParts {
  /** Output stages (gain starts at 0); set() drives their levels. */
  outs: GainNode[]
  srcs: AudioScheduledSourceNode[]
  /** Re-tune with the driving value (pitch, filter) at time t. */
  tune?(x: number, t: number): void
}

/**
 * A continuous voice built on first need and released after a second and a
 * half of silence, so an idle scene holds no running oscillators.
 */
export class Drone {
  private p: (DroneParts & { ac: AudioContext }) | null = null
  private loud = 0

  constructor(private build: (ac: AudioContext) => DroneParts, private tau = 0.05) {}

  /** Levels for up to two outputs (each capped at PEAK); call every frame. */
  set(ac: AudioContext | null, x: number, a: number, b = 0) {
    if (!ac) return this.stop()
    const t = ac.currentTime
    if (a > 1e-4 || b > 1e-4) this.loud = t
    else if (!this.p) return
    else if (t - this.loud > 1.5) return this.stop()
    if (!this.p || this.p.ac !== ac) {
      this.stop()
      this.p = { ac, ...this.build(ac) }
      for (const s of this.p.srcs) s.start(t)
    }
    this.p.tune?.(x, t)
    drive(this.p.outs[0]!, a, t, this.tau)
    if (this.p.outs[1]) drive(this.p.outs[1], b, t, this.tau)
  }

  stop(fade = 0.04) {
    const p = this.p
    if (!p) return
    this.p = null
    const t = p.ac.currentTime
    for (const g of p.outs) {
      hold(g.gain, t)
      g.gain.setTargetAtTime(0, t, fade)
    }
    for (const s of p.srcs) s.stop(t + fade * 8)
  }
}

function drive(g: GainNode, v: number, t: number, tau: number) {
  hold(g.gain, t)
  g.gain.setTargetAtTime(Math.min(PEAK, v), t, tau)
  g.gain.setTargetAtTime(0, t + WATCHDOG, 0.06)
}

/** Slow LFO into a param: osc -> gain(depth) -> param. */
export function lfo(ac: AudioContext, hz: number, depth: number, param: AudioParam) {
  const o = ac.createOscillator()
  o.frequency.value = hz
  const g = ac.createGain()
  g.gain.value = depth
  o.connect(g).connect(param)
  return o
}
