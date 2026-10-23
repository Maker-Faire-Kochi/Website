import { noiseBuffer, soundContext } from '../../../composables/usePanelSound'

/**
 * Makey's voices, synthesised with WebAudio (no files). Each asks
 * soundContext() first and plays nothing on null. One-shots tied to what
 * you see.
 *
 *   step   a big foot on the floor: a soft, low tap
 *   hi     the greeting: a bright two-note "hi-i" chirp as the arm goes up
 *   boing  the hop
 *   thud   hitting the floor in a fall
 */

function tap(ac: AudioContext, t: number, gain: number, freq: number, len: number) {
  const noise = noiseBuffer()
  if (!noise) return
  const src = ac.createBufferSource()
  src.buffer = noise
  const bp = ac.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = freq
  bp.Q.value = 1.2
  const g = ac.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + len)
  src.connect(bp).connect(g).connect(ac.destination)
  src.start(t)
  src.stop(t + len + 0.01)
}

export function playStep(gain = 0.5) {
  const ac = soundContext()
  if (!ac) return
  tap(ac, ac.currentTime, 0.02 + 0.04 * gain, 700 + 200 * gain, 0.035)
}

export function playHi() {
  const ac = soundContext()
  if (!ac) return
  const t0 = ac.currentTime
  const notes: [number, number, number][] = [[660, 990, 0], [990, 1320, 0.11]]
  for (const [f0, f1, d] of notes) {
    const t = t0 + d
    const o = ac.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(f0, t)
    o.frequency.exponentialRampToValueAtTime(f1, t + 0.08)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
    o.connect(g).connect(ac.destination)
    o.start(t)
    o.stop(t + 0.13)
  }
}

export function playBoing() {
  const ac = soundContext()
  if (!ac) return
  const t = ac.currentTime
  const o = ac.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(200, t)
  o.frequency.exponentialRampToValueAtTime(620, t + 0.12)
  o.frequency.exponentialRampToValueAtTime(360, t + 0.34)
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.06, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.36)
  o.connect(g).connect(ac.destination)
  o.start(t)
  o.stop(t + 0.38)
}

export function playThud() {
  const ac = soundContext()
  if (!ac) return
  const t = ac.currentTime
  const o = ac.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(110, t)
  o.frequency.exponentialRampToValueAtTime(50, t + 0.15)
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
  o.connect(g).connect(ac.destination)
  o.start(t)
  o.stop(t + 0.22)
  tap(ac, t, 0.05, 450, 0.07)
}
