import { onMounted, onUnmounted, ref } from 'vue'

/**
 * Key clicks for the homepage panel, synthesised with WebAudio -- no audio
 * files. A press is a short band-passed noise tick over a low thunk; the
 * release is a quieter, higher tick, so a held key sounds like a real switch
 * bottoming out and returning.
 *
 * One delegated listener on the document covers every `.key`, so components
 * never wire sound themselves. The AudioContext is created lazily on the first
 * press, which is also the user gesture browsers require before audio.
 */
const STORAGE_KEY = 'mfk-panel-sound'
const enabled = ref(true)

let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

/**
 * For the 3D scenes' own voices (each scene folder's sound.ts): the shared
 * AudioContext, or null when the rail's Sound key is off OR the visitor has not
 * interacted with the page yet. Scenes must call this per sound and play
 * nothing on null -- that is what keeps the page silent until someone acts.
 */
export function soundContext(): AudioContext | null {
  if (!enabled.value) return null
  const activation = typeof navigator === 'undefined' ? null : (navigator as any).userActivation
  if (activation && !activation.hasBeenActive) return null
  return audio()
}

/** 50ms of white noise in the shared context (after soundContext() returned non-null). */
export function noiseBuffer(): AudioBuffer | null {
  return noise
}

function tick(freq: number, gain: number, dur: number, thunk: number) {
  const ac = audio()
  if (!ac || !noise) return
  const t = ac.currentTime

  const src = ac.createBufferSource()
  src.buffer = noise
  const band = ac.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = freq
  band.Q.value = 1.4
  const g = ac.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(band).connect(g).connect(ac.destination)
  src.start(t)
  src.stop(t + dur + 0.01)

  if (thunk > 0) {
    const osc = ac.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(170, t)
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.05)
    const og = ac.createGain()
    og.gain.setValueAtTime(thunk, t)
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
    osc.connect(og).connect(ac.destination)
    osc.start(t)
    osc.stop(t + 0.07)
  }
}

export function playPress() {
  if (enabled.value) tick(2600, 0.22, 0.018, 0.18)
}

export function playRelease() {
  if (enabled.value) tick(4200, 0.08, 0.012, 0)
}

export function playToggle(on: boolean) {
  tick(on ? 3200 : 1800, 0.25, 0.022, on ? 0.12 : 0.2)
}

export type MachineSound = 'splash' | 'stitch' | 'whirr' | 'rotor' | 'servo' | 'coconut' | 'crash'

/** A dull knock: a sine that drops fast, like something heavy landing on earth. */
function thud(gain: number) {
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime
  const o = ac.createOscillator()
  o.type = 'sine'
  o.frequency.setValueAtTime(170, t)
  o.frequency.exponentialRampToValueAtTime(48, t + 0.18)
  const g = ac.createGain()
  g.gain.setValueAtTime(gain, t)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
  o.connect(g).connect(ac.destination)
  o.start(t)
  o.stop(t + 0.32)
}

/** Filtered noise with a swept cutoff: water, wind, a rotor wash. */
function sweep(from: number, to: number, gain: number, dur: number, q = 0.8) {
  const ac = audio()
  if (!ac || !noise) return
  const t = ac.currentTime
  const src = ac.createBufferSource()
  src.buffer = noise
  src.loop = true
  const f = ac.createBiquadFilter()
  f.type = 'lowpass'
  f.Q.value = q
  f.frequency.setValueAtTime(from, t)
  f.frequency.exponentialRampToValueAtTime(to, t + dur)
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain, t + 0.05)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(f).connect(g).connect(ac.destination)
  src.start(t)
  src.stop(t + dur + 0.02)
}

/** A motor: a detuned saw pair gliding between two pitches. */
function motor(from: number, to: number, gain: number, dur: number) {
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime
  const lp = ac.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 900
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain, t + 0.08)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  for (const detune of [-8, 8]) {
    const o = ac.createOscillator()
    o.type = 'sawtooth'
    o.detune.value = detune
    o.frequency.setValueAtTime(from, t)
    o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.4)
    o.frequency.exponentialRampToValueAtTime(from * 0.8, t + dur)
    o.connect(lp)
    o.start(t)
    o.stop(t + dur + 0.02)
  }
  lp.connect(g).connect(ac.destination)
}

/** One voice per exhibit in the hero drawing. */
export function playMachine(kind: MachineSound) {
  if (!enabled.value) return
  const ac = audio()
  if (!ac) return
  switch (kind) {
    case 'splash':
      window.setTimeout(() => sweep(2400, 300, 0.35, 0.9), 1600)
      motor(60, 90, 0.05, 1.6)
      break
    case 'stitch':
      for (let i = 0; i < 16; i++) window.setTimeout(() => tick(3400, 0.12, 0.012, 0.05), i * 160)
      break
    case 'whirr':
      motor(70, 160, 0.06, 2.6)
      break
    case 'rotor':
      sweep(1800, 600, 0.12, 2.8, 4)
      motor(180, 260, 0.03, 2.8)
      break
    case 'servo':
      motor(300, 520, 0.05, 0.35)
      window.setTimeout(() => tick(2200, 0.2, 0.02, 0.15), 180)
      break
    case 'coconut':
      sweep(3200, 1400, 0.1, 0.6, 2)
      window.setTimeout(() => thud(0.5), 780)
      window.setTimeout(() => thud(0.18), 1000)
      break
    case 'crash':
      sweep(1800, 500, 0.14, 1.4, 4)
      motor(180, 340, 0.04, 1.4)
      window.setTimeout(() => thud(0.45), 1500)
      window.setTimeout(() => thud(0.72), 3100)
      window.setTimeout(() => thud(0.22), 3340)
      break
  }
}

const KEY_SELECTOR = '.key, [data-key-sound]'

export function usePanelSound() {
  let downEl: Element | null = null

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const el = (e.target as Element | null)?.closest?.(KEY_SELECTOR)
    if (!el) return
    downEl = el
    playPress()
  }

  const onUp = () => {
    if (!downEl) return
    downEl = null
    playRelease()
  }

  // Keyboard presses get the same feedback, and the same visible travel.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return
    const el = (document.activeElement as Element | null)?.closest?.(KEY_SELECTOR)
    if (!el) return
    el.classList.add('is-down')
    playPress()
    window.setTimeout(() => {
      el.classList.remove('is-down')
      playRelease()
    }, 110)
  }

  onMounted(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) enabled.value = stored === '1'
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
    document.addEventListener('keydown', onKeyDown)
  })

  onUnmounted(() => {
    document.removeEventListener('pointerdown', onDown)
    document.removeEventListener('pointerup', onUp)
    document.removeEventListener('pointercancel', onUp)
    document.removeEventListener('keydown', onKeyDown)
  })

  function toggle() {
    enabled.value = !enabled.value
    localStorage.setItem(STORAGE_KEY, enabled.value ? '1' : '0')
    playToggle(enabled.value)
    // Off silences what is already sounding too (a scene's running loop), not
    // just what starts next: the shared context is suspended once the toggle's
    // own click has played. The next sound after On resumes it (audio()).
    if (!enabled.value) setTimeout(() => {
      if (!enabled.value) ctx?.suspend()
    }, 200)
  }

  return { enabled, toggle }
}
