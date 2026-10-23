import { soundContext } from '../../../composables/usePanelSound'
import { rng } from '../../core/rng'
import { Drone, Shots, envelope, filter, lfo, longNoise, noiseSource, tone, type DroneParts } from '../../core/voice'
import type { WorkshopEvent } from './sim'

/**
 * The workshop's voices, synthesised with WebAudio: the saw's rasp on every
 * push stroke, the plane's swish with the shaving crackling as it curls, the
 * mallet's knock and the chisel's tick, a faint sprinkle as sawdust settles,
 * wooden clacks as the stool's parts seat and a soft whoosh as it comes apart.
 *
 * Timing comes from the simulation only: one-shots from its per-step events,
 * the rasp and swish levels from its per-step speeds (the rasp's speed is 0
 * on the return stroke, so the saw is silent coming back). soundContext() is
 * asked per call and null plays nothing. The voice building blocks (and the
 * PEAK cap every output stage obeys) are shared with the backwater scene.
 */

/**
 * Saw rasp: band-passed noise chopped by a sawtooth at the rate the teeth
 * pass the end grain, so it buzzes faster as the stroke speeds up.
 */
function buildRasp(ac: AudioContext): DroneParts {
  const src = ac.createBufferSource()
  src.buffer = longNoise(ac)
  src.loop = true
  const hp = filter(ac, 'highpass', 900)
  const band = filter(ac, 'bandpass', 2600, 1.1)
  const am = ac.createGain()
  am.gain.value = 0.6
  const teeth = lfo(ac, 60, 0.4, am.gain)
  teeth.type = 'sawtooth'
  const out = ac.createGain()
  out.gain.value = 0
  src.connect(hp).connect(band).connect(am).connect(out).connect(ac.destination)
  return {
    outs: [out],
    srcs: [src, teeth],
    tune(s, t) {
      teeth.frequency.setTargetAtTime(60 + 190 * s, t, 0.02)
      band.frequency.setTargetAtTime(2000 + 1200 * s, t, 0.02)
    },
  }
}

/** Plane swish: a soft band of noise that brightens with the plane's speed. */
function buildSwish(ac: AudioContext): DroneParts {
  const src = ac.createBufferSource()
  src.buffer = longNoise(ac)
  src.loop = true
  const band = filter(ac, 'bandpass', 1100, 0.9)
  const out = ac.createGain()
  out.gain.value = 0
  src.connect(band).connect(out).connect(ac.destination)
  return {
    outs: [out],
    srcs: [src],
    tune(s, t) {
      band.frequency.setTargetAtTime(800 + 800 * s, t, 0.05)
    },
  }
}

export function workshopSound() {
  const shots = new Shots()
  const rasp = new Drone(buildRasp, 0.02)
  const swish = new Drone(buildSwish, 0.04)
  const r = rng(31)
  let muted = false
  let crackleAcc = 0
  let lastSprinkle = -1

  const ac = () => (muted ? null : soundContext())

  /** A short band of noise: ticks, clacks, crackles. */
  function burst(c: AudioContext, t: number, type: BiquadFilterType, freq: number, q: number, peak: number, decay: number) {
    const n = noiseSource(c, t, decay + 0.02, r.next())
    const f = filter(c, type, freq, q)
    const g = shots.out(c, t + decay + 0.02)
    envelope(g, t, peak, 0.001, decay)
    n.connect(f).connect(g)
  }

  /** A pitched decay (sine or triangle), optionally gliding. */
  function ring(c: AudioContext, t: number, type: OscillatorType, f0: number, f1: number, peak: number, decay: number) {
    const o = tone(c, type, t, f0, f1, decay * 0.6, decay + 0.01)
    const g = shots.out(c, t + decay + 0.01)
    envelope(g, t, peak, 0.002, decay)
    o.connect(g)
  }

  /**
   * Mallet on chisel: a woody, resonant thump (falling sine, a ringing band
   * of the beech head, a hollow triangle) with the steel tick of the chisel
   * on top. Each blow in a set lands a little lower as the mortise deepens.
   */
  function knock(blow: number) {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    const k = 1 - 0.03 * blow
    ring(c, t, 'sine', 190 * k, 120 * k, 0.2, 0.16)
    burst(c, t, 'bandpass', 820 * k, 6, 0.18, 0.09)
    ring(c, t, 'triangle', 410 * k, 410 * k, 0.06, 0.07)
    burst(c, t, 'highpass', 4500, 0.7, 0.06, 0.012)
    ring(c, t, 'sine', 2900, 2900, 0.03, 0.06)
  }

  /** Turned beech seating in its socket: a dry, bright clack with a little body. */
  function clack(c: AudioContext, t: number, freq: number, peak: number, body: number) {
    burst(c, t, 'bandpass', freq, 5, peak, 0.05)
    ring(c, t, 'sine', body, body, peak * 0.45, 0.045)
  }

  return {
    /** Thumbnail-sized slots stay silent: a preview should not double the sound. */
    setMuted(m: boolean) {
      muted = m
      if (m) this.silence()
    },

    event(e: WorkshopEvent) {
      const c = ac()
      if (!c) return
      const t = c.currentTime
      switch (e.kind) {
        case 'knock':
          return knock(e.blow)
        case 'seat':
          // Legs and rungs arrive together: a quick flam of three clacks. The
          // seat drops on last, lower and fuller.
          if (e.part === 'frame') {
            clack(c, t, 1900, 0.14, 640)
            clack(c, t + 0.018, 1600, 0.12, 560)
            clack(c, t + 0.037, 1750, 0.1, 600)
          }
          else {
            clack(c, t, 1100, 0.18, 320)
          }
          return
        case 'explode': {
          const n = noiseSource(c, t, 0.8, r.next())
          const band = filter(c, 'bandpass', 400, 0.8)
          band.frequency.setValueAtTime(400, t)
          band.frequency.exponentialRampToValueAtTime(1400, t + 0.5)
          const g = shots.out(c, t + 0.8)
          envelope(g, t, 0.05, 0.25, 0.5)
          n.connect(band).connect(g)
          return
        }
        case 'tap':
          // A knuckle on the bench top.
          ring(c, t, 'sine', 240, 140, 0.12, 0.08)
          burst(c, t, 'bandpass', 900, 3, 0.06, 0.03)
      }
    },

    /**
     * Every fixed step: the plane's crackle (the shaving curling off the
     * iron) at a rate that follows the plane's speed, and the sprinkle of
     * grains settling this step -- dust barely audible, chips a little more.
     */
    step(dt: number, planeSpeed: number, dust: number, chips: number) {
      if (planeSpeed <= 0 && dust === 0 && chips === 0) return
      const c = ac()
      if (!c) return
      const t = c.currentTime
      crackleAcc += 30 * planeSpeed * dt
      while (crackleAcc >= 1) {
        crackleAcc -= 1
        burst(c, t + r.next() * 0.01, 'bandpass', 3000 + 1500 * r.next(), 2, 0.03 + 0.02 * r.next(), 0.006)
      }
      if (chips > 0) burst(c, t, 'bandpass', 2200, 3, 0.04, 0.02)
      else if (dust > 0 && t - lastSprinkle > 0.03) {
        lastSprinkle = t
        burst(c, t, 'highpass', 5000, 0.7, 0.004 * Math.min(3, dust), 0.004)
      }
    },

    /** Every frame: saw push speed (0 on the pull) and plane speed, each 0..1. */
    frame(sawSpeed: number, planeSpeed: number) {
      const c = ac()
      const s = sawSpeed < 0.05 ? 0 : sawSpeed
      rasp.set(c, s, 0.16 * s)
      swish.set(c, planeSpeed, 0.09 * planeSpeed)
    },

    /** Pause, hide, dispose: fade everything now. */
    silence() {
      rasp.stop()
      swish.stop()
      shots.silence()
      crackleAcc = 0
    },
  }
}
