import { soundContext } from '../../../composables/usePanelSound'
import { cutoffHz, hz, type Voice } from './music'

/**
 * The noise machine's synth: WebAudio only, no files. It owns no musical
 * logic; every frame it copies the Voice (music.ts) onto the audio graph and
 * measures what actually came out, so the cone and the NOISE headline move
 * with the real sound.
 *
 *   tri ─┐
 *   saw ─┼─ lowpass ─ vca ─┬──────────────┬─ master (≤0.2) ─ limiter ─ analyser ─ out
 *   saw'─┘                 └─ delay ⇄ fb ─┘ (wet)
 *
 * The graph exists only while the voice sounds (plus its echo tail) and only
 * if soundContext() hands out a context, i.e. the rail's Sound key is on AND
 * the visitor has interacted with the page. Otherwise nothing is built and
 * `level` stays 0.
 */

const MASTER = 0.16
/** RMS that reads as full level: a held bright note through the limiter measures about 0.07-0.09. */
const FULL_RMS = 0.1
/** Seconds of silence after which the echo tail is gone and the graph is torn down. */
const TAIL_S = 2.5

interface Graph {
  ac: AudioContext
  oscs: OscillatorNode[]
  mix: GainNode[]
  filter: BiquadFilterNode
  vca: GainNode
  fb: GainNode
  wet: GainNode
  master: GainNode
  nodes: AudioNode[]
  analyser: AnalyserNode
  buf: Float32Array<ArrayBuffer>
}

export class Synth {
  /** Smoothed output level, 0..1, measured from the analyser. */
  level = 0
  private g: Graph | null = null
  private quiet = 0

  /** True while a graph is running (the visitor can hear this synth). */
  get live() {
    return this.g !== null
  }

  /** Called once per rendered frame with the real elapsed time. */
  update(v: Voice, dt: number) {
    if (v.sounding) {
      this.quiet = 0
      // Per sound: the Sound key may have been turned off mid-phrase.
      const ac = soundContext()
      if (!ac) {
        this.stop()
        return
      }
      if (!this.g || this.g.ac !== ac) {
        this.stop()
        this.g = build(ac, v)
      }
    }
    else if (this.g) {
      this.quiet += dt
      if (this.quiet > TAIL_S) this.stop()
    }
    const g = this.g
    if (!g) {
      this.level = 0
      return
    }
    const t = g.ac.currentTime
    const f = hz(v.semis)
    for (const o of g.oscs) o.frequency.setTargetAtTime(f, t, 0.01)
    const k = v.knobs[0]
    // Tone: a soft triangle morphs into two detuned saws.
    g.mix[0]!.gain.setTargetAtTime(0.9 * (1 - k) ** 2, t, 0.03)
    g.mix[1]!.gain.setTargetAtTime(0.55 * k, t, 0.03)
    g.mix[2]!.gain.setTargetAtTime(0.4 * k, t, 0.03)
    g.oscs[1]!.detune.setTargetAtTime(-6 * k, t, 0.05)
    g.oscs[2]!.detune.setTargetAtTime(5 + 18 * k, t, 0.05)
    g.filter.frequency.setTargetAtTime(cutoffHz(v.brightness), t, 0.02)
    g.vca.gain.setTargetAtTime(v.env, t, 0.006)
    // Echo: feedback stays well under 1, so the tail always dies away.
    const e = v.knobs[1]
    g.fb.gain.setTargetAtTime(0.55 * e, t, 0.05)
    g.wet.gain.setTargetAtTime(0.5 * e, t, 0.05)

    g.analyser.getFloatTimeDomainData(g.buf)
    let sum = 0
    for (let i = 0; i < g.buf.length; i++) sum += g.buf[i]! * g.buf[i]!
    const target = Math.min(1, Math.sqrt(sum / g.buf.length) / FULL_RMS)
    const tau = target > this.level ? 0.025 : 0.14
    this.level = target + (this.level - target) * Math.exp(-Math.max(0, dt) / tau)
  }

  /** Stop all sound now: a 20 ms fade (no click), then the graph is released. */
  stop() {
    const g = this.g
    this.g = null
    this.level = 0
    this.quiet = 0
    if (!g) return
    const t = g.ac.currentTime
    g.master.gain.cancelScheduledValues(t)
    g.master.gain.setTargetAtTime(0, t, 0.02)
    g.fb.gain.cancelScheduledValues(t)
    g.fb.gain.setValueAtTime(0, t)
    for (const o of g.oscs) {
      try {
        o.stop(t + 0.15)
      }
      catch {}
    }
    g.oscs[0]!.onended = () => {
      for (const n of g.nodes) n.disconnect()
    }
  }
}

function build(ac: AudioContext, v: Voice): Graph {
  const t = ac.currentTime
  const types: OscillatorType[] = ['triangle', 'sawtooth', 'sawtooth']
  const oscs = types.map((type) => {
    const o = ac.createOscillator()
    o.type = type
    o.frequency.value = hz(v.semis)
    return o
  })
  const mix = oscs.map(() => {
    const g = ac.createGain()
    g.gain.value = 0
    return g
  })
  const filter = ac.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = 4
  filter.frequency.value = cutoffHz(v.brightness)
  const vca = ac.createGain()
  vca.gain.value = 0
  const delay = ac.createDelay(1)
  delay.delayTime.value = 0.3
  const fb = ac.createGain()
  fb.gain.value = 0
  const wet = ac.createGain()
  wet.gain.value = 0
  const master = ac.createGain()
  master.gain.setValueAtTime(0, t)
  master.gain.setTargetAtTime(MASTER, t, 0.01)
  // A gentle limiter: nothing the knobs or the echo do can jump out of the speakers.
  const limiter = ac.createDynamicsCompressor()
  limiter.threshold.value = -14
  limiter.knee.value = 8
  limiter.ratio.value = 8
  limiter.attack.value = 0.003
  limiter.release.value = 0.2
  const analyser = ac.createAnalyser()
  analyser.fftSize = 512

  oscs.forEach((o, i) => o.connect(mix[i]!).connect(filter))
  filter.connect(vca)
  vca.connect(master)
  vca.connect(delay)
  delay.connect(fb).connect(delay)
  delay.connect(wet).connect(master)
  master.connect(limiter).connect(analyser).connect(ac.destination)
  for (const o of oscs) o.start(t)

  return {
    ac, oscs, mix, filter, vca, fb, wet, master, analyser,
    nodes: [...oscs, ...mix, filter, vca, delay, fb, wet, master, limiter, analyser],
    buf: new Float32Array(new ArrayBuffer(analyser.fftSize * 4)),
  }
}
