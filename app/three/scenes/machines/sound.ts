import { noiseBuffer, soundContext } from '../../../composables/usePanelSound'

/**
 * The machine room's voices, synthesised with WebAudio in the shared context.
 * Every voice asks soundContext() first and plays nothing on null (Sound off,
 * or the visitor has not interacted yet). All short and quiet; the only
 * sustained one, the whirr, exists only while the visitor is winding (or the
 * train is unwinding from it) and dies on its own if nobody updates it.
 */

function click(ac: AudioContext, at: number, freq: number, gain: number, dur: number, q = 5) {
  const noise = noiseBuffer()
  if (!noise) return
  const src = ac.createBufferSource()
  src.buffer = noise
  const band = ac.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = freq
  band.Q.value = q
  const g = ac.createGain()
  g.gain.setValueAtTime(gain, at)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  src.connect(band).connect(g).connect(ac.destination)
  src.start(at)
  src.stop(at + dur + 0.01)
}

/** The escapement's tick (even seconds) or tock (odd): a soft wooden knock. */
export function tick(odd: boolean) {
  const ac = soundContext()
  if (!ac) return
  const t = ac.currentTime
  click(ac, t, odd ? 2300 : 2700, 0.035, 0.03, 7)
  const o = ac.createOscillator()
  o.type = 'sine'
  o.frequency.value = odd ? 1180 : 1320
  const g = ac.createGain()
  g.gain.setValueAtTime(0.012, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04)
  o.connect(g).connect(ac.destination)
  o.start(t)
  o.stop(t + 0.05)
}

/** The ratchet pawl dropping back in: three quick clicks, falling away. */
export function ratchet(strong = true) {
  const ac = soundContext()
  if (!ac) return
  const t = ac.currentTime
  const n = strong ? 3 : 1
  for (let i = 0; i < n; i++) click(ac, t + i * 0.034, 2100 - i * 180, (strong ? 0.12 : 0.06) * (1 - i * 0.28), 0.025, 4)
}

/**
 * Gear whirr: a buzz at the fastest mesh's tooth rate (pinion D's 12 teeth
 * against E), through a low-pass, plus a little band-passed noise. Pitch and
 * level follow the crank speed.
 */
export class Whirr {
  private ac: AudioContext | null = null
  private osc: OscillatorNode | null = null
  private src: AudioBufferSourceNode | null = null
  private band: BiquadFilterNode | null = null
  private gain: GainNode | null = null
  private timer: ReturnType<typeof setTimeout> | undefined

  /** crankRev: crank turns per second (signed). */
  set(crankRev: number) {
    const speed = Math.abs(crankRev)
    if (speed < 0.05) return this.stop()
    if (!this.gain && !this.start()) return
    const ac = this.ac!
    const t = ac.currentTime
    const mesh = 72 * speed
    this.osc!.frequency.setTargetAtTime(Math.min(900, 30 + mesh), t, 0.03)
    this.band!.frequency.setTargetAtTime(Math.min(4000, 600 + mesh * 6), t, 0.05)
    this.gain!.gain.setTargetAtTime(Math.min(0.07, 0.03 * Math.sqrt(speed)), t, 0.05)
    // If updates stop (slot scrolled away, scene paused or disposed), fade out on our own.
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.stop(), 200)
  }

  private start(): boolean {
    const ac = soundContext()
    const noise = noiseBuffer()
    if (!ac || !noise) return false
    this.ac = ac
    const gain = ac.createGain()
    gain.gain.value = 0
    gain.connect(ac.destination)
    const lp = ac.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 900
    lp.connect(gain)
    const osc = ac.createOscillator()
    osc.type = 'sawtooth'
    const og = ac.createGain()
    og.gain.value = 0.5
    osc.connect(og).connect(lp)
    const src = ac.createBufferSource()
    src.buffer = noise
    src.loop = true
    const band = ac.createBiquadFilter()
    band.type = 'bandpass'
    band.Q.value = 2
    const ng = ac.createGain()
    ng.gain.value = 0.6
    src.connect(band).connect(ng).connect(gain)
    osc.start()
    src.start()
    this.osc = osc
    this.src = src
    this.band = band
    this.gain = gain
    return true
  }

  stop() {
    clearTimeout(this.timer)
    if (!this.gain || !this.ac) return
    const t = this.ac.currentTime
    this.gain.gain.cancelScheduledValues(t)
    this.gain.gain.setTargetAtTime(0, t, 0.04)
    this.osc!.stop(t + 0.25)
    this.src!.stop(t + 0.25)
    this.osc = null
    this.src = null
    this.band = null
    this.gain = null
  }
}
