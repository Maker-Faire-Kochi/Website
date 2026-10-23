/**
 * The noise machine's musical brain, as pure logic: no AudioContext, no three.
 * synth.ts turns a Voice's state into sound every frame and the scene turns it
 * into motion, so both always agree on what is playing, and the tests can run
 * the whole thing in node.
 *
 * Pitch is quantised to a minor pentatonic scale (any note sounds fine against
 * any other, which is what a stranger waving a mouse needs) and glides between
 * notes in semitone space, like a theremin with its hand moving.
 */

/** Minor pentatonic, semitones above the root. */
export const SCALE = [0, 3, 5, 7, 10] as const
export const OCTAVES = 2
/** Notes in the playable range: two octaves of the scale plus the top root. */
export const NOTES = SCALE.length * OCTAVES + 1
export const SEMIS = 12 * OCTAVES
/** A2. Low enough to feel in a laptop speaker, high enough to hear in a phone. */
export const ROOT_HZ = 110

/** Clamps to 0..1; NaN (a bad drag delta) reads as 0 rather than poisoning the audio graph. */
export const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)
const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)))

/** Semitones above the root of scale note `i` (0..NOTES-1). */
export function noteSemis(i: number) {
  const k = clampInt(i, 0, NOTES - 1)
  return 12 * Math.floor(k / SCALE.length) + SCALE[k % SCALE.length]!
}

/** A 0..1 control position snapped to the nearest scale note, in semitones. */
export function quantize(x01: number) {
  return noteSemis(Math.round(clamp01(x01) * (NOTES - 1)))
}

export function hz(semis: number) {
  return ROOT_HZ * 2 ** (semis / 12)
}

/** One-pole glide: exact for any dt, never overshoots, never jumps. */
export function glide(cur: number, target: number, dt: number, tau: number) {
  return target + (cur - target) * Math.exp(-dt / tau)
}

/** Filter cutoff for a 0..1 control: 220 Hz (dark) to ~4 kHz (bright), log spaced. */
export function cutoffHz(y01: number) {
  return 220 * 18 ** clamp01(y01)
}

/** A pot's 270 degree sweep: 0 at seven o'clock, 1 at five o'clock. */
export function knobAngle(v: number) {
  return (-0.75 + 1.5 * clamp01(v)) * Math.PI
}

/** 112 bpm, eighth notes. */
export const ARP_NOTE = 60 / 112 / 2
/**
 * The four-bar arpeggio, as scale-note indices: one rising-and-falling figure
 * per bar over a i - iv - ii - v walk, ending on the octave.
 */
export const ARP: number[] = (() => {
  const figure = [0, 2, 4, 5, 7, 5, 4, 2]
  const roots = [0, 3, 1, 4]
  const out: number[] = []
  for (const r of roots) for (const f of figure) out.push(Math.min(NOTES - 1, r + f))
  out[out.length - 1] = 5
  return out
})()

export const PHRASE_NOTE = 0.14
/** A short phrase rising from `base` (touch: one tap = one phrase). */
export function phraseNotes(base: number) {
  return [0, 1, 2, 3, 4, 3, 5, 2].map(d => Math.min(NOTES - 1, base + d))
}

export type Mode = 'off' | 'hold' | 'arp' | 'phrase'

const GATE = 0.72
const ATTACK = 0.008

/**
 * One monophonic voice. `hold` is the theremin (gate open, pitch and cutoff
 * follow the pointer); `arp` and `phrase` are sequenced and stop by themselves.
 * Advance it only with step(dt); everything is a pure function of the steps
 * and the calls made between them.
 */
export class Voice {
  mode: Mode = 'off'
  /** Knob 1 = tone (waveform morph + detune), knob 2 = echo amount. Always 0..1. */
  knobs: [number, number] = [0.35, 0.3]
  /** Current (glided) pitch, semitones above the root. */
  semis = 12
  target = 12
  /** Pointer-controlled cutoff, 0..1, and the value it glides to. */
  cutoff = 0.62
  cutoffTarget = 0.62
  gate = false
  /** Amplitude envelope 0..1. */
  env = 0
  /** Per-note filter accent for sequenced notes, 0..1. */
  accent = 0
  private seq: number[] = []
  private noteLen = 0
  private idx = 0
  private t = 0

  /** Theremin on (or moved): x picks the note, y the brightness. */
  hold(x01: number, y01: number) {
    if (this.mode !== 'hold') {
      this.mode = 'hold'
      this.seq = []
    }
    this.gate = true
    this.move(x01, y01)
  }

  move(x01: number, y01: number) {
    if (this.mode !== 'hold') return
    this.target = quantize(x01)
    this.cutoffTarget = clamp01(y01)
  }

  arp() {
    this.sequence(ARP, ARP_NOTE, 'arp')
  }

  phrase(x01: number) {
    this.sequence(phraseNotes(Math.round(clamp01(x01) * (NOTES - 6))), PHRASE_NOTE, 'phrase')
  }

  /** Close the gate; the envelope releases on its own. */
  release() {
    this.mode = 'off'
    this.gate = false
    this.seq = []
  }

  /** Silence now (pause, leave, dispose): no release tail. */
  silence() {
    this.release()
    this.env = 0
    this.accent = 0
  }

  setKnob(i: 0 | 1, v: number) {
    this.knobs[i] = clamp01(v)
  }

  get sounding() {
    return this.gate || this.env > 0.002
  }

  /** Effective cutoff 0..1: the control, opened by each sequenced note's accent. */
  get brightness() {
    return this.mode === 'hold' ? this.cutoff : clamp01(this.cutoff * 0.75 + 0.35 * this.accent)
  }

  /**
   * The level this voice would produce, 0..1, from the envelope alone. Drives
   * the drawing deterministically, and the cone when no audio is running.
   */
  get modelLevel() {
    return this.env * (0.7 + 0.2 * this.knobs[0])
  }

  step(dt: number) {
    if (this.mode === 'arp' || this.mode === 'phrase') {
      this.t += dt
      let playing = true
      while (playing && this.t >= this.noteLen) {
        this.t -= this.noteLen
        this.idx++
        if (this.idx < this.seq.length) {
          this.note()
        }
        else {
          this.release()
          playing = false
        }
      }
      if (playing) this.gate = this.t < this.noteLen * GATE
    }
    const seqd = this.mode === 'arp' || this.mode === 'phrase'
    this.semis = glide(this.semis, this.target, dt, seqd ? 0.012 : 0.085)
    this.cutoff = glide(this.cutoff, this.cutoffTarget, dt, 0.05)
    this.env = glide(this.env, this.gate ? 1 : 0, dt, this.gate ? ATTACK : seqd ? 0.06 : 0.14)
    this.accent = glide(this.accent, 0, dt, 0.12)
  }

  private sequence(notes: number[], len: number, mode: Mode) {
    this.mode = mode
    this.seq = notes
    this.noteLen = len
    this.idx = 0
    this.t = 0
    this.note()
    this.gate = true
  }

  private note() {
    this.target = noteSemis(this.seq[this.idx]!)
    this.accent = 1
  }
}
