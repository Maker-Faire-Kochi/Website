import { soundContext } from '../../../composables/usePanelSound'
import { rng } from '../../core/rng'
import { Drone, PEAK, Shots, envelope, filter, hold, lfo, longNoise, noiseSource, tone, type DroneParts } from '../../core/voice'
import type { SimEvent } from './sim'

/**
 * The backwater's voices, synthesised with WebAudio (no files): rope creak
 * and pulley squeak while the boom moves, the net's splash, drip plinks, a
 * coconut's whoosh and thunk or plop, palm-frond rustle, water lapping under
 * a hovering pointer.
 *
 * Nothing here decides WHEN a sound happens: one-shots are played from the
 * simulation's per-step events (sim.ts `events`) and the continuous voices
 * are set every frame from what is drawn, so every sound is tied to a visible
 * event. soundContext() is asked per call and a null (Sound off, or no user
 * gesture yet) plays nothing. Every voice's output stage peaks at PEAK or
 * less. The building blocks are in app/three/core/voice.ts.
 */

/**
 * Rope creak and pulley squeak. The creak is stick-slip: a slow, wavering
 * sawtooth whose every reset rings a narrow band-pass, so it ticks like
 * coir rope working over wood -- faster and brighter as the boom swings
 * faster. The squeak is a thin wavering tone that only joins at speed.
 */
function buildBoom(ac: AudioContext): DroneParts {
  const a = ac.createOscillator()
  a.type = 'sawtooth'
  const b = ac.createOscillator()
  b.type = 'sawtooth'
  const band = filter(ac, 'bandpass', 420, 8)
  const creak = ac.createGain()
  creak.gain.value = 0
  a.connect(band)
  b.connect(band)
  band.connect(creak).connect(ac.destination)
  const waver = lfo(ac, 0.7, 4, a.frequency)

  const sq = ac.createOscillator()
  sq.type = 'triangle'
  const vib = lfo(ac, 6, 18, sq.frequency)
  const sqBand = filter(ac, 'bandpass', 1300, 3)
  const am = ac.createGain()
  am.gain.value = 0.5
  const flutter = lfo(ac, 1.3, 0.5, am.gain)
  const squeak = ac.createGain()
  squeak.gain.value = 0
  sq.connect(sqBand).connect(am).connect(squeak).connect(ac.destination)

  return {
    outs: [creak, squeak],
    srcs: [a, b, waver, sq, vib, flutter],
    tune(s, t) {
      a.frequency.setTargetAtTime(9 + 30 * s, t, 0.05)
      b.frequency.setTargetAtTime((9 + 30 * s) * 1.37, t, 0.05)
      band.frequency.setTargetAtTime(380 + 260 * s, t, 0.05)
      sq.frequency.setTargetAtTime(950 + 450 * s, t, 0.05)
    },
  }
}

/** Water lapping: low-passed noise swelling on two slow, unrelated waves. */
function buildLap(ac: AudioContext): DroneParts {
  const src = ac.createBufferSource()
  src.buffer = longNoise(ac)
  src.loop = true
  const low = filter(ac, 'lowpass', 520, 0.5)
  const am = ac.createGain()
  am.gain.value = 0.55
  const w1 = lfo(ac, 0.29, 0.25, am.gain)
  const w2 = lfo(ac, 0.61, 0.18, am.gain)
  const out = ac.createGain()
  out.gain.value = 0
  src.connect(low).connect(am).connect(out).connect(ac.destination)
  return { outs: [out], srcs: [src, w1, w2] }
}

const smoothstep = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return u * u * (3 - 2 * u)
}

/** 0..1 from a position: drips at different spots ring at different pitches, deterministically. */
const hash = (x: number, z: number) => {
  const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453
  return h - Math.floor(h)
}

export function backwaterSound() {
  const shots = new Shots()
  const boom = new Drone(buildBoom)
  const lap = new Drone(buildLap, 0.25)
  const r = rng(77)
  let muted = false
  let lastDrip = -1
  let lastRustle = -1

  const ac = () => (muted ? null : soundContext())

  /** The net slapping in: a falling wash of noise over a low whump. */
  function splash(speed: number) {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    const k = 0.6 + 0.4 * Math.min(1, speed / 0.34)
    const wash = noiseSource(c, t, 1.1, r.next())
    const low = filter(c, 'lowpass', 3200)
    low.frequency.setValueAtTime(3200, t)
    low.frequency.exponentialRampToValueAtTime(350, t + 0.9)
    const g1 = shots.out(c, t + 1.1)
    envelope(g1, t, 0.2 * k, 0.012, 0.9)
    wash.connect(low).connect(g1)

    const whump = tone(c, 'sine', t, 110, 42, 0.25, 0.32)
    const g2 = shots.out(c, t + 0.35)
    envelope(g2, t, 0.16 * k, 0.008, 0.3)
    whump.connect(g2)

    // The sheet of water pouring through the mesh after the slap.
    const pour = noiseSource(c, t, 1.4, r.next())
    const band = filter(c, 'bandpass', 1800, 0.6)
    const g3 = shots.out(c, t + 1.4)
    envelope(g3, t + 0.03, 0.05 * k, 0.06, 1.2)
    pour.connect(band).connect(g3)
  }

  /** A single drop: a sine that rises fast, the classic plink. */
  function drip(x: number, z: number) {
    const c = ac()
    if (!c) return
    const t = c.currentTime
    if (t - lastDrip < 0.04) return
    lastDrip = t
    const f = 700 + 900 * hash(x, z)
    const o = tone(c, 'sine', t, f, f * 1.9, 0.025, 0.09)
    const g = shots.out(c, t + 0.1)
    envelope(g, t, 0.035, 0.002, 0.07)
    o.connect(g)
  }

  /** Air rushing past a falling nut, rising until it lands `fall` seconds from now. */
  function whoosh(fall: number) {
    const c = ac()
    if (!c || fall < 0.15) return
    const t = c.currentTime
    const s = noiseSource(c, t, fall + 0.1, r.next())
    const band = filter(c, 'bandpass', 450, 1.2)
    band.frequency.setValueAtTime(450, t)
    band.frequency.exponentialRampToValueAtTime(1500, t + fall)
    const g = shots.out(c, t + fall + 0.1)
    g.gain.setValueAtTime(1e-4, t)
    g.gain.exponentialRampToValueAtTime(0.05, t + fall * 0.95)
    g.gain.linearRampToValueAtTime(0, t + fall + 0.03)
    s.connect(band).connect(g)
  }

  /** A husked coconut on packed earth: a dull falling thud with a short fibrous slap. */
  function thunk(speed: number) {
    const c = ac()
    if (!c) return
    const k = Math.min(1, speed / 10)
    if (k < 0.03) return
    const t = c.currentTime
    const o = tone(c, 'sine', t, 150, 58, 0.14, 0.25)
    const g = shots.out(c, t + 0.25)
    envelope(g, t, 0.22 * k, 0.004, 0.22)
    o.connect(g)
    const n = noiseSource(c, t, 0.08, r.next())
    const low = filter(c, 'lowpass', 900)
    const g2 = shots.out(c, t + 0.08)
    envelope(g2, t, 0.12 * k, 0.002, 0.05)
    n.connect(low).connect(g2)
  }

  /** Into the water: the rising bloop of the cavity closing, then a small splash. */
  function plop(speed: number) {
    const c = ac()
    if (!c) return
    const k = 0.5 + 0.5 * Math.min(1, speed / 10)
    const t = c.currentTime
    const o = tone(c, 'sine', t, 240, 520, 0.06, 0.16)
    const g = shots.out(c, t + 0.16)
    envelope(g, t, 0.14 * k, 0.004, 0.12)
    o.connect(g)
    const n = noiseSource(c, t, 0.5, r.next())
    const low = filter(c, 'lowpass', 2600)
    low.frequency.setValueAtTime(2600, t)
    low.frequency.exponentialRampToValueAtTime(500, t + 0.4)
    const g2 = shots.out(c, t + 0.5)
    envelope(g2, t, 0.12 * k, 0.006, 0.45)
    n.connect(low).connect(g2)
  }

  /**
   * A coconut bouncing off a child's head (the easter egg): soft and hollow,
   * a cartoon "bonk" rather than an impact -- a short sine that drops a fifth,
   * with a breath of husk noise. Nobody is hurt.
   */
  function bonk(speed: number) {
    const c = ac()
    if (!c) return
    const k = 0.6 + 0.4 * Math.min(1, speed / 8)
    const t = c.currentTime
    const o = tone(c, 'sine', t, 520, 340, 0.09, 0.2)
    const g = shots.out(c, t + 0.22)
    envelope(g, t, 0.12 * k, 0.003, 0.18)
    o.connect(g)
    const n = noiseSource(c, t, 0.05, r.next())
    const band = filter(c, 'bandpass', 1400, 0.8)
    const g2 = shots.out(c, t + 0.05)
    envelope(g2, t, 0.05 * k, 0.002, 0.04)
    n.connect(band).connect(g2)
  }

  return {
    /** Thumbnail-sized slots stay silent: a preview should not double the sound. */
    setMuted(m: boolean) {
      muted = m
      if (m) this.silence()
    },

    /** One physical event from the step that just ran. */
    event(e: SimEvent) {
      switch (e.kind) {
        case 'splash': return splash(e.speed)
        case 'drip': return drip(e.x, e.z)
        case 'nut-drop': return whoosh(e.fall)
        case 'nut-bank': return thunk(e.speed)
        case 'nut-plop': return plop(e.speed)
        case 'nut-bonk': return bonk(e.speed)
      }
    },

    /**
     * Every frame: boom angular speed (0..1 of its fastest) and whether the
     * pointer is over the water. Creak follows the speed; the squeak only
     * joins once the boom is really moving.
     */
    frame(speed: number, overWater: boolean) {
      const c = ac()
      const s = speed < 0.03 ? 0 : Math.min(1, speed)
      boom.set(c, s, 0.11 * s ** 1.2, 0.03 * smoothstep(0.4, 1, s))
      lap.set(c, 0, overWater ? 0.07 : 0)
    },

    /** Fronds brushing: bright noise in uneven crackles. strength 0..1. */
    rustle(strength: number) {
      const c = ac()
      if (!c) return
      const t = c.currentTime
      if (t - lastRustle < 0.18) return
      lastRustle = t
      const dur = 0.6
      const n = noiseSource(c, t, dur, r.next())
      const hp = filter(c, 'highpass', 1500)
      const band = filter(c, 'bandpass', 4200, 0.6)
      const crackle = c.createGain()
      for (let k = 0; k * 0.018 < dur; k++) crackle.gain.setValueAtTime(0.25 + 0.75 * r.next(), t + k * 0.018)
      const g = shots.out(c, t + dur)
      envelope(g, t, 0.1 * Math.min(1, strength), 0.04, 0.55)
      n.connect(hp).connect(band).connect(crackle).connect(g)
    },

    /** Pointer left (or the slot went away): stop what hovering started. */
    leave() {
      lap.stop(0.12)
    },

    /** Pause, hide, dispose: fade everything now. */
    silence() {
      boom.stop()
      lap.stop()
      shots.silence()
    },
  }
}

export type BackwaterSound = ReturnType<typeof backwaterSound>
