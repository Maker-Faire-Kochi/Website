<script setup lang="ts">
import type { SceneName } from '~/three/scenes'
import type { SlotHandle, SlotPointer } from '~/three/core/stage'

/**
 * A place on the page where a 3D scene appears.
 *
 * Server side it is only a reserved box holding the poster image, so no-JS,
 * Save-Data, reduced-motion and no-WebGL visitors get a finished picture and
 * no layout shift. In the browser, once the box is within a viewport of the
 * screen, three.js and the scene's own chunk are imported and the scene is
 * attached to the page's single stage. The poster hides only after the
 * scene's first frame has actually been drawn, and comes back if the context
 * is lost.
 *
 * Input: the canvas never receives events. Pointer events are delegated from
 * `inputHost` (the closest matching ancestor, default the slot itself), so
 * links, buttons, text selection and touch scrolling keep working on top.
 */
const props = withDefaults(defineProps<{
  scene: SceneName
  /** Poster base path without width/extension, e.g. /img/scenes/hero -> hero-1440.avif */
  poster?: string
  /** Cache revision for posters whose composition has changed. */
  posterVersion?: string
  posterAlt?: string
  /** CSS selector for the ancestor that receives pointer input. */
  inputHost?: string
  /** The poster is the first screen's largest image (the hero): fetch it first. Others load lazily. */
  priority?: boolean
  /** When the phone poster (a different composition) applies: match the layout's own breakpoint. */
  phoneMedia?: string
  /** object-position of the poster: the centre of the focus box, so a cover crop keeps the subject. */
  posterPosition?: string
}>(), { posterAlt: '', priority: false, phoneMedia: '(max-width: 767px)', posterPosition: '50% 50%' })

/** 'unavailable': this visitor will only ever see the poster (Save-Data, no WebGL, build failed). */
const emit = defineEmits<{ unavailable: [] }>()

const root = ref<HTMLElement | null>(null)
const showPoster = ref(true)
const posterUrl = (width: number, ext: string) => `${props.poster}-${width}.${ext}${props.posterVersion ? `?v=${encodeURIComponent(props.posterVersion)}` : ''}`
const { state, init } = useMotion()

const IGNORE = 'a, button, input, select, textarea, label, summary, [role="button"], [contenteditable], [data-scene-ignore]'
const TAP_SLOP = 10
const TAP_MS = 350

let handle: SlotHandle | null = null
/**
 * The one attach in flight, from the first await to the last. Every caller
 * (the near-observer, a motion change) goes through attach(), which returns
 * this instead of starting a second build -- two concurrent builds for one
 * element were a duplicate slot and a leaked stage.
 */
let inflight: Promise<void> | null = null
let cancelled = false
let near: IntersectionObserver | null = null
let host: HTMLElement | null = null
let down: { id: number, x: number, y: number, t: number } | null = null
let scrolledSinceDown = false

const posterMode = import.meta.dev && typeof location !== 'undefined' && new URLSearchParams(location.search).has('poster')

// Set server-side from the Save-Data request header (see components/home/Hero.vue); read here, never recomputed.
const saveDataHeader = useState<boolean | undefined>('hero-save-data')

function saveData() {
  return Boolean(saveDataHeader.value) || Boolean((navigator as any).connection?.saveData)
}

/**
 * 3D never competes with the page's own load: wait for the load event, then
 * for the browser to go idle (capped at 2.5s). The poster is the same pose,
 * so the hand-over is invisible.
 */
function afterLoadIdle(): Promise<void> {
  const idle = () => new Promise<void>((resolve) => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => resolve(), { timeout: props.priority ? 250 : 750 })
    else setTimeout(resolve, props.priority ? 0 : 100)
  })
  if (document.readyState === 'complete') return idle()
  return new Promise(resolve => window.addEventListener('load', () => idle().then(resolve), { once: true }))
}

/** Probed once per page, and the probe's context released straight away. */
let webgl: boolean | null = null
function hasWebGL() {
  if (webgl !== null) return webgl
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null
    webgl = Boolean(gl)
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  }
  catch {
    webgl = false
  }
  return webgl
}

function toPointer(kind: SlotPointer['kind'], e: PointerEvent | null): SlotPointer | null {
  const el = root.value
  if (!el) return null
  const r = el.getBoundingClientRect()
  const x = e ? e.clientX - r.left : 0
  const y = e ? e.clientY - r.top : 0
  return {
    kind, x, y,
    buttons: e?.buttons ?? 0,
    ndc: { x: (x / Math.max(1, r.width)) * 2 - 1, y: -((y / Math.max(1, r.height)) * 2 - 1) },
  }
}

function onMove(e: PointerEvent) {
  // Touch has no hover; a moving finger is a scroll, not a gaze target.
  if (e.pointerType === 'touch') return
  const p = toPointer('move', e)
  if (p) handle?.pointer(p)
}

function onLeave(e: PointerEvent) {
  // A finger lifting fires pointerleave on every tap; forwarding it would
  // cancel whatever that tap just started. Off-screen is handled by the stage.
  if (e.pointerType === 'touch') return
  const p = toPointer('leave', null)
  if (p) handle?.pointer(p)
}

/** A mouse/pen press that started on the drawing (not on text or a control): a drag in progress. */
let pressed: number | null = null

function onDown(e: PointerEvent) {
  // Only a primary press is a tap: a right-click opens the context menu, not a robot reaction.
  if ((e.pointerType === 'mouse' && e.button !== 0) || (e.target as Element | null)?.closest(IGNORE)) {
    down = null
    return
  }
  down = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() }
  scrolledSinceDown = false
  if (e.pointerType === 'touch') return
  // A press on the drawing itself (not on any text) is a grab: no text
  // selection while dragging, and the pointer is captured so the drag and its
  // release still arrive if it leaves the section.
  const t = e.target as Element | null
  const onDrawing = !t || t === host || Boolean(root.value?.contains(t))
  if (!onDrawing) return
  e.preventDefault()
  host?.setPointerCapture?.(e.pointerId)
  pressed = e.pointerId
  const p = toPointer('down', e)
  if (p) handle?.pointer(p)
}

function release(e: PointerEvent | null) {
  if (pressed === null) return
  if (e && host?.hasPointerCapture?.(pressed)) host.releasePointerCapture(pressed)
  pressed = null
  const p = toPointer('up', e)
  if (p) handle?.pointer(p)
}

function onUp(e: PointerEvent) {
  if (e.pointerId === pressed) release(e)
  const d = down
  down = null
  if (!d || d.id !== e.pointerId || scrolledSinceDown) return
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP || performance.now() - d.t > TAP_MS) return
  const p = toPointer('tap', e)
  if (p) handle?.pointer(p)
}

function onCancel(e: PointerEvent) {
  down = null
  if (e.pointerId === pressed) release(e)
}

function onScroll() {
  scrolledSinceDown = true
}

function bindInput() {
  host = (props.inputHost && root.value?.closest<HTMLElement>(props.inputHost)) || root.value
  if (!host) return
  host.addEventListener('pointermove', onMove, { passive: true })
  host.addEventListener('pointerleave', onLeave, { passive: true })
  // Not passive: a grab on the drawing prevents text selection.
  host.addEventListener('pointerdown', onDown)
  host.addEventListener('pointerup', onUp, { passive: true })
  host.addEventListener('pointercancel', onCancel, { passive: true })
  window.addEventListener('scroll', onScroll, { passive: true })
}

function unbindInput() {
  if (!host) return
  host.removeEventListener('pointermove', onMove)
  host.removeEventListener('pointerleave', onLeave)
  host.removeEventListener('pointerdown', onDown)
  host.removeEventListener('pointerup', onUp)
  host.removeEventListener('pointercancel', onCancel)
  window.removeEventListener('scroll', onScroll)
  host = null
}

const reduced = () => state.value === 'reduced'

function attach(): Promise<void> {
  if (handle || !root.value) return Promise.resolve()
  inflight ??= build().catch((e) => {
    // A scene that throws while building leaves the poster up; it never takes the page down.
    if (import.meta.dev) console.error('[SceneSlot]', props.scene, e)
    emit('unavailable')
  }).finally(() => {
    inflight = null
  })
  return inflight
}

async function build() {
  if (reduced()) return
  if (saveData() || !hasWebGL()) {
    emit('unavailable')
    return
  }
  await afterLoadIdle()
  if (cancelled || reduced()) return
  const [{ getStage, releaseStageIfIdle }, { SCENES }] = await Promise.all([import('~/three/core/stage'), import('~/three/scenes')])
  const mod = await SCENES[props.scene]()
  // Re-checked after every await: the visitor may have turned motion off, or
  // navigated away, while the chunks were loading.
  if (cancelled || !root.value || reduced()) return
  const stage = getStage()
  if (!stage) {
    emit('unavailable')
    return
  }
  const added = await stage.add(root.value, mod.default, {
    posterMode,
    isCancelled: () => cancelled || reduced(),
    onFirstFrame: () => {
      showPoster.value = false
      if (posterMode) requestAnimationFrame(() => requestAnimationFrame(() => {
        (window as any).__posterReady = true
      }))
    },
    onFail: () => {
      showPoster.value = true
    },
  })
  if (!added) {
    releaseStageIfIdle()
    return
  }
  handle = added
  // Motion may have changed while the scene was building (a Pause pressed
  // during load): hand the stage the CURRENT state, not the one we started with.
  stage.setMotion(state.value)
  bindInput()
}

async function detach() {
  unbindInput()
  if (!handle) return
  handle.remove()
  handle = null
  showPoster.value = true
  const { releaseStageIfIdle } = await import('~/three/core/stage')
  releaseStageIfIdle()
}

onMounted(() => {
  init()
  near = new IntersectionObserver((entries) => {
    if (!entries.some(e => e.isIntersecting)) return
    near?.disconnect()
    near = null
    attach()
  }, { rootMargin: '100% 0px' })
  near.observe(root.value!)
  // Prewarm a screen ahead. Distant scenes must not consume CPU or GPU memory
  // while the visitor is reading the hero. Stage serialises all near builds.
})

watch(state, async (s) => {
  if (s === 'reduced') return detach()
  // Still waiting to come near the viewport, or mid-build: build() reads the
  // current state when it finishes, so there is nothing to forward yet.
  if (!handle) return near || inflight ? undefined : attach()
  const { getStage } = await import('~/three/core/stage')
  getStage()?.setMotion(s)
})

/** For keyboard controls beside the slot: runs a named scene action, returns a status line or null. */
defineExpose({ action: (name: string) => handle?.action(name) ?? null })

onBeforeUnmount(() => {
  cancelled = true
  near?.disconnect()
  detach()
})
</script>

<template>
  <div ref="root" class="scene-slot" :data-scene="scene">
    <picture v-if="poster" class="scene-poster" :class="{ 'is-hidden': !showPoster }">
      <!-- Art-directed: below 768px the phone composition (4:3, the phone cast)
           is a different drawing, so it is chosen by media, not by width. -->
      <source :media="phoneMedia" type="image/avif" :srcset="posterUrl(768, 'avif')">
      <source :media="phoneMedia" type="image/webp" :srcset="posterUrl(768, 'webp')">
      <source type="image/avif" :srcset="`${posterUrl(1440, 'avif')} 1440w, ${posterUrl(2160, 'avif')} 2160w`" sizes="100vw">
      <source type="image/webp" :srcset="`${posterUrl(1440, 'webp')} 1440w, ${posterUrl(2160, 'webp')} 2160w`" sizes="100vw">
      <img :src="posterUrl(1440, 'webp')" :alt="posterAlt" :fetchpriority="priority ? 'high' : undefined" :loading="priority ? undefined : 'lazy'" :decoding="priority ? undefined : 'async'" :style="{ objectPosition: posterPosition }">
    </picture>
  </div>
</template>

<style scoped>
.scene-slot {
  position: relative;
  /* The canvas is behind the page; the slot itself must stay transparent. */
  background: transparent;
}

.scene-poster,
.scene-poster img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.scene-poster {
  transition: opacity 200ms ease-out;
}

.scene-poster.is-hidden {
  opacity: 0;
  visibility: hidden;
}
</style>
