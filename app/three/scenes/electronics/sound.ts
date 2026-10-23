import { noiseBuffer, soundContext } from '../../../composables/usePanelSound'
import { rng } from '../../core/rng'
import { Drone, envelope, filter, lfo, longNoise, noiseSource, Shots, tone, type DroneParts } from '../../core/voice'

/**
 * The workbench's voices, synthesised with WebAudio. The electronics: the
 * servo's whirr (its pitch follows the arm's angular speed), the button's
 * click, the buzzer's chirp and a soft two-note chime when the board powers
 * up. The bench (benchSound): the iron's sizzle on a joint, its tick in and
 * out of the coil, the drill press and mitre saw motors (levels follow the
 * simulated spin), the saw's cut and the multimeter's beep. Every voice asks for the
 * shared context per sound and plays nothing when it gets null (Sound off, or
 * no interaction yet). All short and quiet; the whirr lives only while the
 * servo moves and fades out by itself if it stops being fed (a slot scrolled
 * away mid-sweep stops calling frame()).
 */

interface Whirr { ac: AudioContext, oscs: OscillatorNode[], filter: BiquadFilterNode, gain: GainNode, end: number }
let whirr: Whirr | null = null

/** Below this speed (deg/s) the servo is silent. */
const QUIET = 6
/** The whirr dies this long after its last update. */
const LINGER = 0.25

/** Call every frame with the servo's angular speed in deg/s. */
export function servoWhirr(speed: number) {
  if (whirr && whirr.ac.currentTime > whirr.end) whirr = null
  if (speed < QUIET) {
    if (whirr) fadeWhirr(0.05)
    return
  }
  if (!whirr) {
    const ac = soundContext()
    if (!ac) return
    const t = ac.currentTime
    const filter = ac.createBiquadFilter()
    filter.type = 'bandpass'
    filter.Q.value = 2.5
    filter.frequency.value = 900
    const gain = ac.createGain()
    // A plain value, not an automation event: the update below cancels events from `t` on.
    gain.gain.value = 0.0001
    filter.connect(gain).connect(ac.destination)
    // A gear-train buzz: a sawtooth and a square a fifth apart, slightly detuned.
    const oscs = (['sawtooth', 'square'] as OscillatorType[]).map((type, i) => {
      const o = ac.createOscillator()
      o.type = type
      o.detune.value = i ? 702 + 6 : -6
      o.connect(filter)
      o.start(t)
      return o
    })
    whirr = { ac, oscs, filter, gain, end: t + LINGER }
  }
  const { ac, oscs, filter, gain } = whirr
  const t = ac.currentTime
  const f = 120 + speed * 0.9
  for (const o of oscs) o.frequency.setTargetAtTime(f, t, 0.03)
  filter.frequency.setTargetAtTime(600 + speed * 4, t, 0.03)
  const level = 0.045 * Math.min(1, speed / 220)
  gain.gain.cancelScheduledValues(t)
  gain.gain.setTargetAtTime(level, t, 0.03)
  // Fail-safe: unless the next frame renews it, the voice fades and stops.
  gain.gain.setTargetAtTime(0.0001, t + LINGER * 0.5, 0.03)
  whirr.end = t + LINGER
  for (const o of oscs) o.stop(t + LINGER + 0.05)
}

function fadeWhirr(tau: number) {
  if (!whirr) return
  const { ac, oscs, gain } = whirr
  const t = ac.currentTime
  gain.gain.cancelScheduledValues(t)
  gain.gain.setTargetAtTime(0.0001, t, tau)
  for (const o of oscs) o.stop(t + tau * 5)
  whirr.end = t + tau * 5
}

/** Pause or teardown: silence everything this scene started. */
export function stopSounds() {
  fadeWhirr(0.02)
  whirr = null
}

/** Tactile switch: a bright band-passed noise tick over a tiny thunk. Release is quieter and higher. */
export function click(down: boolean) {
  const ac = soundContext()
  const noise = noiseBuffer()
  if (!ac || !noise) return
  const t = ac.currentTime
  const src = ac.createBufferSource()
  src.buffer = noise
  const band = ac.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = down ? 3600 : 4800
  band.Q.value = 3
  const g = ac.createGain()
  const peak = down ? 0.18 : 0.1
  g.gain.setValueAtTime(peak, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.015)
  src.connect(band).connect(g).connect(ac.destination)
  src.start(t)
  src.stop(t + 0.02)
  if (!down) return
  const o = ac.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(240, t)
  o.frequency.exponentialRampToValueAtTime(90, t + 0.03)
  const og = ac.createGain()
  og.gain.setValueAtTime(0.06, t)
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.04)
  o.connect(og).connect(ac.destination)
  o.start(t)
  o.stop(t + 0.05)
}

/** One piezo beep: a square wave near the disc's resonance, hard-edged as a real buzzer is. */
export function beep(len = 0.07) {
  const ac = soundContext()
  if (!ac) return
  const t = ac.currentTime
  const o = ac.createOscillator()
  o.type = 'square'
  o.frequency.value = 2900
  const lp = ac.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 5000
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(0.035, t + 0.004)
  g.gain.setValueAtTime(0.035, t + len - 0.006)
  g.gain.linearRampToValueAtTime(0.0001, t + len)
  o.connect(lp).connect(g).connect(ac.destination)
  o.start(t)
  o.stop(t + len + 0.01)
}

/** Power-up: two soft sine notes a fifth apart. */
export function bootChime() {
  const ac = soundContext()
  if (!ac) return
  const t = ac.currentTime
  ;[[659.25, 0], [987.77, 0.11]].forEach(([f, at]) => {
    const o = ac.createOscillator()
    o.type = 'sine'
    o.frequency.value = f!
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, t + at!)
    g.gain.exponentialRampToValueAtTime(0.09, t + at! + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, t + at! + 0.35)
    o.connect(g).connect(ac.destination)
    o.start(t + at!)
    o.stop(t + at! + 0.37)
  })
}

// ── The workbench's voices ────────────────────────────────────────────────

/**
 * Solder sizzle: flux boiling off a joint is a soft, crackly hiss -- high
 * band-passed noise, its level following the tip's contact, with a quick
 * crackle chopping it.
 */
function buildSizzle(ac: AudioContext): DroneParts {
  const src = ac.createBufferSource()
  src.buffer = longNoise(ac)
  src.loop = true
  const band = filter(ac, 'bandpass', 5200, 1.4)
  const hp = filter(ac, 'highpass', 2500)
  const am = ac.createGain()
  am.gain.value = 0.55
  const crackle = lfo(ac, 23, 0.45, am.gain)
  crackle.type = 'square'
  const out = ac.createGain()
  out.gain.value = 0
  src.connect(hp).connect(band).connect(am).connect(out).connect(ac.destination)
  return { outs: [out], srcs: [src, crackle] }
}

/** A motor: a buzz at the shaft's rate plus its harmonics, through a filter that opens with speed; noise for the air. */
function buildMotor(base: number, bright: number) {
  return (ac: AudioContext): DroneParts => {
    const saw = ac.createOscillator()
    saw.type = 'sawtooth'
    const sq = ac.createOscillator()
    sq.type = 'square'
    sq.detune.value = 1200 + 7
    const lp = filter(ac, 'lowpass', 600, 1.2)
    const noise = ac.createBufferSource()
    noise.buffer = longNoise(ac)
    noise.loop = true
    const nb = filter(ac, 'bandpass', bright, 0.8)
    const tonal = ac.createGain()
    tonal.gain.value = 0
    const air = ac.createGain()
    air.gain.value = 0
    saw.connect(lp)
    sq.connect(lp)
    lp.connect(tonal).connect(ac.destination)
    noise.connect(nb).connect(air).connect(ac.destination)
    return {
      outs: [tonal, air],
      srcs: [saw, sq, noise],
      tune(x, t) {
        const f = base * (0.25 + 0.75 * x)
        saw.frequency.setTargetAtTime(f, t, 0.05)
        sq.frequency.setTargetAtTime(f, t, 0.05)
        lp.frequency.setTargetAtTime(400 + 2600 * x, t, 0.05)
        nb.frequency.setTargetAtTime(bright * (0.5 + 0.5 * x), t, 0.05)
      },
    }
  }
}

export function benchSound() {
  const shots = new Shots()
  const sizzle = new Drone(buildSizzle, 0.03)
  const drill = new Drone(buildMotor(190, 1800), 0.06)
  const saw = new Drone(buildMotor(330, 4200), 0.06)
  const r = rng(77)
  let muted = false
  const ac = () => (muted ? null : soundContext())

  return {
    /** Every frame: tip on a joint (0..1), drill and saw motor levels (0..1). */
    update(contact: number, drillSpin: number, sawSpin: number) {
      const c = ac()
      sizzle.set(c, contact, 0.045 * contact)
      drill.set(c, drillSpin, 0.05 * drillSpin, 0.02 * drillSpin)
      saw.set(c, sawSpin, 0.055 * sawSpin, 0.035 * sawSpin)
    },
    /** The saw biting into the strip: a rough band of noise, a fraction of a second. */
    cut() {
      const c = ac()
      if (!c) return
      const t = c.currentTime
      const n = noiseSource(c, t, 0.55, r.next())
      const f = filter(c, 'bandpass', 1500, 0.9)
      const am = c.createGain()
      am.gain.value = 0.7
      const teeth = lfo(c, 70, 0.3, am.gain)
      teeth.start(t)
      teeth.stop(t + 0.6)
      const g = shots.out(c, t + 0.6)
      envelope(g, t, 0.12, 0.02, 0.5)
      n.connect(f).connect(am).connect(g)
    },
    /** Continuity beep: a clean 2.7 kHz tone for a quarter second. */
    meterBeep() {
      const c = ac()
      if (!c) return
      const t = c.currentTime
      const o = tone(c, 'square', t, 2700, 2700, 0, 0.26)
      const lp = filter(c, 'lowpass', 4500)
      const g = shots.out(c, t + 0.3)
      g.gain.setValueAtTime(0.0001, t)
      g.gain.linearRampToValueAtTime(0.03, t + 0.005)
      g.gain.setValueAtTime(0.03, t + 0.25)
      g.gain.linearRampToValueAtTime(0.0001, t + 0.26)
      o.connect(lp).connect(g)
    },
    /** The iron clicking into or out of its coil: a small metallic tick. */
    tick(out: boolean) {
      const c = ac()
      if (!c) return
      const t = c.currentTime
      const n = noiseSource(c, t, 0.05, r.next())
      const f = filter(c, 'bandpass', out ? 4200 : 3400, 6)
      const g = shots.out(c, t + 0.06)
      envelope(g, t, 0.05, 0.001, 0.04)
      n.connect(f).connect(g)
    },
    setMuted(m: boolean) {
      muted = m
      if (m) this.stop()
    },
    stop() {
      shots.silence()
      sizzle.stop()
      drill.stop()
      saw.stop()
    },
  }
}
