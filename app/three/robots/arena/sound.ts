import { noiseBuffer, soundContext } from '../../../composables/usePanelSound'

/**
 * The props' voices, synthesised with WebAudio (no files); each asks
 * soundContext() first and plays nothing on null (Sound off, or the visitor
 * has not interacted yet). Quiet, short, tied to a visible impact.
 *
 *   tick    the ball bouncing off a rail, a block or a robot: a hollow
 *           plastic tick, louder and brighter for a harder hit
 *   scrape  a block shoved across the plywood: a short filtered rasp
 */
export function playTick(speed: number) {
  const ac = soundContext()
  const noise = noiseBuffer()
  if (!ac || !noise) return
  const t = ac.currentTime
  const level = Math.min(1, speed / 0.8)
  const o = ac.createOscillator()
  o.type = 'triangle'
  o.frequency.setValueAtTime(700 + 500 * level, t)
  o.frequency.exponentialRampToValueAtTime(420, t + 0.05)
  const g = ac.createGain()
  g.gain.setValueAtTime(0.015 + 0.07 * level, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
  o.connect(g).connect(ac.destination)
  o.start(t)
  o.stop(t + 0.07)
  const src = ac.createBufferSource()
  src.buffer = noise
  const bp = ac.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 3200
  const ng = ac.createGain()
  ng.gain.setValueAtTime(0.01 + 0.04 * level, t)
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.015)
  src.connect(bp).connect(ng).connect(ac.destination)
  src.start(t)
  src.stop(t + 0.02)
}

export function playScrape(speed: number) {
  const ac = soundContext()
  const noise = noiseBuffer()
  if (!ac || !noise) return
  const t = ac.currentTime
  const level = Math.min(1, speed / 0.4)
  const src = ac.createBufferSource()
  src.buffer = noise
  src.loop = true
  const lp = ac.createBiquadFilter()
  lp.type = 'bandpass'
  lp.frequency.setValueAtTime(900, t)
  lp.frequency.exponentialRampToValueAtTime(500, t + 0.14)
  lp.Q.value = 1.5
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.02 + 0.05 * level, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
  src.connect(lp).connect(g).connect(ac.destination)
  src.start(t)
  src.stop(t + 0.18)
}
