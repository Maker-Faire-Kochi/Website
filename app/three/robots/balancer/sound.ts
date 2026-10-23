import { noiseBuffer, soundContext } from '../../../composables/usePanelSound'

/**
 * The balancer's voices, synthesised with WebAudio (no files). Each call asks
 * soundContext() first and plays nothing on null -- Sound off, or the visitor
 * has not touched the page yet -- so the stage stays silent until someone acts.
 *
 *   whine    the gear motor: a filtered saw whose pitch follows wheel speed.
 *            Very quiet. It is kept alive only by being updated: every update
 *            re-arms a stop 0.6 s ahead, so when the robot stops stepping
 *            (scene scrolled away, motion paused, tab hidden) it dies by
 *            itself instead of droning on.
 *   thud     the head bumper landing in a fall.
 *   ratchet  the kickstand's pawl clicking as it swings out or folds away.
 *
 * Peak gains stay well under 0.25; everything is scheduled on the audio clock.
 */
export class BalancerVoice {
  private osc: OscillatorNode | null = null
  private gain: GainNode | null = null

  /** speed: wheel surface speed, m/s (0 .. ~0.3). */
  whine(speed: number) {
    const ac = soundContext()
    if (!ac) {
      this.stop()
      return
    }
    const level = Math.min(1, speed / 0.25)
    const t = ac.currentTime
    if (!this.osc) {
      if (level < 0.06) return
      const osc = ac.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = 160
      const lp = ac.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 1300
      const g = ac.createGain()
      g.gain.value = 0
      osc.connect(lp).connect(g).connect(ac.destination)
      osc.start(t)
      osc.onended = () => {
        if (this.osc === osc) {
          this.osc = null
          this.gain = null
        }
        g.disconnect()
      }
      this.osc = osc
      this.gain = g
    }
    this.osc.frequency.setTargetAtTime(150 + 480 * level, t, 0.05)
    const g = this.gain!.gain
    g.cancelScheduledValues(t)
    g.setTargetAtTime(0.012 * level, t, 0.06)
    // Fade and stop unless the next update (50 ms away) renews it.
    g.setTargetAtTime(0, t + 0.2, 0.05)
    if (level >= 0.06) this.osc.stop(t + 0.6)
  }

  /** The bumper hits the ground. strength 0..1 from the impact rate. */
  thud(strength: number) {
    const ac = soundContext()
    if (!ac) return
    const t = ac.currentTime
    const o = ac.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(150, t)
    o.frequency.exponentialRampToValueAtTime(45, t + 0.2)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.06 + 0.16 * strength, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
    o.connect(g).connect(ac.destination)
    o.start(t)
    o.stop(t + 0.3)
    const noise = noiseBuffer()
    if (!noise) return
    const src = ac.createBufferSource()
    src.buffer = noise
    const lp = ac.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 700
    const ng = ac.createGain()
    ng.gain.setValueAtTime(0.05 + 0.1 * strength, t)
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
    src.connect(lp).connect(ng).connect(ac.destination)
    src.start(t)
    src.stop(t + 0.06)
  }

  /** `clicks` pawl ticks spread over `dur` seconds. */
  ratchet(clicks: number, dur: number) {
    const ac = soundContext()
    const noise = noiseBuffer()
    if (!ac || !noise) return
    const t0 = ac.currentTime
    for (let i = 0; i < clicks; i++) {
      const t = t0 + (i / clicks) * dur
      const src = ac.createBufferSource()
      src.buffer = noise
      const bp = ac.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 3400 - i * 120
      bp.Q.value = 3
      const g = ac.createGain()
      g.gain.setValueAtTime(0.07, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.014)
      src.connect(bp).connect(g).connect(ac.destination)
      src.start(t)
      src.stop(t + 0.02)
    }
  }

  /** Silence now (pause, dispose). */
  stop() {
    const osc = this.osc
    if (!osc) return
    this.osc = null
    this.gain = null
    try {
      osc.stop()
    }
    catch {}
  }
}
