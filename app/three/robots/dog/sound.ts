import { noiseBuffer, soundContext } from '../../../composables/usePanelSound'

/**
 * The dog's voices, synthesised with WebAudio (no files). Each asks
 * soundContext() first and plays nothing on null (Sound off, or the visitor
 * has not interacted yet). All are one-shots tied to a visible event.
 *
 *   paw    a pair of pads touching down: a soft rubber tick
 *   yip    the happy hop: two quick rising blips (a servo-ish chirp, not a bark)
 *   thud   hitting the ground in a fall, and rolling back onto its belly
 */

function tick(ac: AudioContext, t: number, gain: number, freq: number, len: number) {
  const noise = noiseBuffer()
  if (!noise) return
  const src = ac.createBufferSource()
  src.buffer = noise
  const bp = ac.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = freq
  bp.Q.value = 1.1
  const g = ac.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + len)
  src.connect(bp).connect(g).connect(ac.destination)
  src.start(t)
  src.stop(t + len + 0.01)
}

export function playPaw(gain = 0.5) {
  const ac = soundContext()
  if (!ac) return
  tick(ac, ac.currentTime, 0.012 + 0.025 * gain, 900 + 300 * gain, 0.025)
}

export function playYip() {
  const ac = soundContext()
  if (!ac) return
  const t0 = ac.currentTime
  for (let k = 0; k < 2; k++) {
    const t = t0 + k * 0.09
    const o = ac.createOscillator()
    o.type = 'triangle'
    o.frequency.setValueAtTime(700 + k * 200, t)
    o.frequency.exponentialRampToValueAtTime(1300 + k * 300, t + 0.06)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07)
    o.connect(g).connect(ac.destination)
    o.start(t)
    o.stop(t + 0.08)
  }
}

export function playThud(gain = 1) {
  const ac = soundContext()
  if (!ac) return
  const t = ac.currentTime
  const o = ac.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(120, t)
  o.frequency.exponentialRampToValueAtTime(55, t + 0.14)
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.12 * gain, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
  o.connect(g).connect(ac.destination)
  o.start(t)
  o.stop(t + 0.2)
  tick(ac, t, 0.05 * gain, 500, 0.06)
}
