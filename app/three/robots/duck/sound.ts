import { noiseBuffer, soundContext } from '../../../composables/usePanelSound'

/**
 * The duck's voices, synthesised with WebAudio (no files). Each one asks
 * soundContext() first and plays nothing on null (Sound off, or the visitor
 * has not interacted yet). All are one-shots tied to a visible event, so
 * nothing outlives the motion that caused it.
 *
 *   step   a soft tap per sole touchdown: a plastic foot on paper
 *   boing  the hop's take-off: a sprung pitch bend with a wobble
 *   chirp  a servo starting a quick head move
 */

function tap(ac: AudioContext, t: number, gain: number, freq: number) {
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
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
  src.connect(bp).connect(g).connect(ac.destination)
  src.start(t)
  src.stop(t + 0.035)
}

/** One foot down. `gain` 0..1 (a landing is louder than a step). */
export function playStep(gain = 0.5) {
  const ac = soundContext()
  if (!ac) return
  tap(ac, ac.currentTime, 0.02 + 0.05 * gain, 1300 + 400 * gain)
}

export function playBoing() {
  const ac = soundContext()
  if (!ac) return
  const t = ac.currentTime
  const o = ac.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(170, t)
  o.frequency.exponentialRampToValueAtTime(560, t + 0.11)
  o.frequency.exponentialRampToValueAtTime(320, t + 0.36)
  // The spring's wobble: a fast vibrato that dies with the note.
  const lfo = ac.createOscillator()
  lfo.frequency.value = 17
  const depth = ac.createGain()
  depth.gain.setValueAtTime(28, t)
  depth.gain.exponentialRampToValueAtTime(1, t + 0.36)
  lfo.connect(depth).connect(o.frequency)
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.07, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38)
  o.connect(g).connect(ac.destination)
  o.start(t)
  lfo.start(t)
  o.stop(t + 0.4)
  lfo.stop(t + 0.4)
}

/** A servo slewing: a short square-wave glide, up or down. */
export function playChirp(up: boolean) {
  const ac = soundContext()
  if (!ac) return
  const t = ac.currentTime
  const o = ac.createOscillator()
  o.type = 'square'
  o.frequency.setValueAtTime(up ? 900 : 1500, t)
  o.frequency.exponentialRampToValueAtTime(up ? 1500 : 900, t + 0.07)
  const lp = ac.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 2600
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.014, t + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08)
  o.connect(lp).connect(g).connect(ac.destination)
  o.start(t)
  o.stop(t + 0.09)
}

/** The body hitting the ground in a fall: a dull plastic thump. strength 0..1. */
export function playThump(strength: number) {
  const ac = soundContext()
  if (!ac) return
  const t = ac.currentTime
  const o = ac.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(190, t)
  o.frequency.exponentialRampToValueAtTime(60, t + 0.16)
  const g = ac.createGain()
  g.gain.setValueAtTime(0.05 + 0.15 * strength, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
  o.connect(g).connect(ac.destination)
  o.start(t)
  o.stop(t + 0.24)
  tap(ac, t, 0.04 + 0.08 * strength, 900)
}
