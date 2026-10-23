import { knobAngle, SEMIS, Voice } from './music'
import { Plotter } from './plotter'

/**
 * Everything that moves in the "Make Some Noise" scene, advanced in fixed
 * steps: the voice (what is playing), the speaker cone, the knob caps and the
 * plotter. Pure and seeded; the scene draws interpolated snapshots of it and
 * synth.ts sounds the voice.
 */

/**
 * Peak forward excursion of the cone (m). A long-throw woofer's worth (16 mm):
 * real 8" cones move less, but seen three-quarter on at band size anything
 * smaller is a few pixels and the pumping would not read.
 */
export const XMAX = 0.016
/** The cone may swing back past rest by at most this fraction of XMAX. */
export const XBACK = 0.3

/** Float64 snapshot layout, interpolated between steps by the scene. */
export const SNAP = {
  cone: 0,
  knob1: 1,
  knob2: 2,
  penX: 3,
  penZ: 4,
  lift: 5,
  sheet: 6, // off0, op0, off1, op1
  size: 10,
}

// The cone is a damped spring chasing the level (a real cone has mass and a
// suspension): it pumps out on every note and settles with a little overshoot.
const CONE_W = 2 * Math.PI * 8
const CONE_ZETA = 0.45
const FLUTTER_HZ = 9

export class NoiseSim {
  voice = new Voice()
  plot: Plotter
  /**
   * Measured output level (0..1) from the analyser while audio runs; null
   * when nothing sounds (no AudioContext), and the cone follows the voice's
   * modelled level instead.
   */
  drive: number | null = null
  cone = 0
  private coneV = 0
  private coneRaw = 0
  private flutter = 0
  knobShown: [number, number]

  constructor(seed: number) {
    this.plot = new Plotter(seed)
    this.knobShown = [knobAngle(this.voice.knobs[0]), knobAngle(this.voice.knobs[1])]
  }

  /** Level that moves the cone: the real one when sounding, else the model. */
  get coneLevel() {
    return Math.max(0, Math.min(1, this.drive ?? this.voice.modelLevel))
  }

  step(dt: number) {
    const v = this.voice
    v.step(dt)

    const L = this.coneLevel
    const a = CONE_W * CONE_W * (XMAX * L - this.coneRaw) - 2 * CONE_ZETA * CONE_W * this.coneV
    this.coneV += a * dt
    this.coneRaw += this.coneV * dt
    this.flutter += 2 * Math.PI * FLUTTER_HZ * dt
    if (this.flutter > Math.PI * 2) this.flutter -= Math.PI * 2
    const x = this.coneRaw + 0.15 * XMAX * L * Math.sin(this.flutter)
    this.cone = Math.max(-XBACK * XMAX, Math.min(XMAX, x))

    // Knob caps follow their values with a short ease (a hand turning a pot).
    for (const i of [0, 1] as const) {
      const target = knobAngle(v.knobs[i])
      this.knobShown[i] = target + (this.knobShown[i] - target) * Math.exp(-dt / 0.06)
    }

    // The drawing hears the MODEL, so the same taps draw the same picture
    // whether or not this visitor's browser is allowed to make sound.
    this.plot.step(dt, { pitch01: v.semis / SEMIS, active: v.sounding, level: v.modelLevel })
  }

  snapshot(out: Float64Array) {
    const p = this.plot
    out[SNAP.cone] = this.cone
    out[SNAP.knob1] = this.knobShown[0]
    out[SNAP.knob2] = this.knobShown[1]
    out[SNAP.penX] = p.pen.x
    out[SNAP.penZ] = p.pen.z
    out[SNAP.lift] = p.pen.lift
    out[SNAP.sheet] = p.sheets[0]!.off
    out[SNAP.sheet + 1] = p.sheets[0]!.op
    out[SNAP.sheet + 2] = p.sheets[1]!.off
    out[SNAP.sheet + 3] = p.sheets[1]!.op
    return out
  }

  /** Pause / leave / dispose: drop everything that is playing. */
  silence() {
    this.voice.silence()
    this.drive = null
  }
}
