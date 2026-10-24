<script setup lang="ts">
import type { SceneName } from '~/three/scenes'

/**
 * A full-screen chapter: the scene is drawn edge to edge in a sticky
 * one-screen stage, and the chapter's panels (the default slot, each a
 * `.chapter-panel`) scroll over one side of it. The stage frames the scene's
 * subject inside the FOCUS box (`focus` on wide screens, `phoneFocus` at
 * 740px and below; "x0 x1 y0 y1" as fractions of the screen, see fit() in
 * app/three/core/stage.ts), so the panels never cover what the scene is about
 * while the scene's world still runs to every edge.
 *
 * Panels are opaque (text never sits on a moving frame). As each panel's
 * centre crosses the middle of the screen it becomes the chapter's step:
 * `progress` is emitted continuously (0 at the first panel, n-1 at the last)
 * and `stepActions[i]`, if given, runs as a scene action when panel i is
 * reached, so scrolling tells the scene's story. The caption, hint and the
 * keyboard equivalents of every pointer interaction (WCAG 2.1.1) sit in a dock
 * at the top of the stage; their results go to a polite live region.
 */
const props = withDefaults(defineProps<{
  scene: SceneName
  caption: string
  hint?: string
  controls: { action: string, label: string }[]
  poster?: string
  posterVersion?: string
  posterAlt?: string
  focus: string
  phoneFocus: string
  /** Which side the panels take on wide screens: the focus box is on the other. */
  side?: 'left' | 'right'
  stepActions?: (string | null)[]
  /** Report scroll through the final panel for a closing scene event. */
  tail?: boolean
  /** A scene's live hover label (its label.ts), drawn as a callout. */
  hoverLabel?: { text: string, x: number, y: number, visible: boolean }
}>(), { side: 'left', posterAlt: '' })

const emit = defineEmits<{ progress: [p: number], tailProgress: [p: number] }>()

const { state: motion, view } = useMotion()
const root = ref<HTMLElement | null>(null)
const slot = ref<{ action: (name: string) => string | null } | null>(null)
const status = ref('')
const unavailable = ref(false)
const phone = ref(false)
const active = ref(-1)

const stage = ref<HTMLElement | null>(null)
const dock = ref<HTMLElement | null>(null)
/**
 * Where the drawing's room ends, as a fraction of the stage's height: the top
 * of the dock (wide screens: the bottom corner, over the nav; phones: under
 * the scene), or of the floating nav if that is higher. The focus box stops
 * there, so a scene never frames its subject under the dock or the nav,
 * whatever the screen and however the dock wraps.
 */
const clearTo = ref<number | null>(null)

/**
 * Phones reserve a stable space for the drawing and dock. Text scrolls in
 * the band beneath them, including panels longer than a screen.
 */
function measureBand() {
  const el = root.value
  const s = stage.value?.getBoundingClientRect()
  if (!el) return
  if (!phone.value || !s?.height) {
    el.style.removeProperty('--stick')
    return
  }
  const dockHeight = dock.value?.offsetHeight ?? 0
  const stick = Math.min(0.64 * s.height, Math.max(0.54 * s.height, dockHeight + 0.3 * s.height + 8))
  el.style.setProperty('--stick', `${Math.round(stick)}px`)
}

function measureDock() {
  const s = stage.value?.getBoundingClientRect()
  const d = dock.value?.getBoundingClientRect()
  if (!s || !d || d.height <= 0 || s.height <= 0) {
    clearTo.value = null
    return
  }
  // The nav is fixed to the screen, not the stage: measured up from the screen's bottom, which the pinned stage fills.
  const nav = document.querySelector('.rail-wrap')?.getBoundingClientRect()
  const navTop = nav && nav.height > 0 ? 1 - (window.innerHeight - nav.top) / s.height : 1
  clearTo.value = Math.min((d.top - s.top) / s.height, navTop)
}

const focusNow = computed(() => {
  const base = phone.value ? props.phoneFocus : props.focus
  const to = clearTo.value
  if (to == null || !base.trim()) return base
  const [x0 = 0, x1 = 1, y0 = 0, y1 = 1] = base.trim().split(/\s+/).map(Number)
  return `${x0} ${x1} ${y0} ${Math.min(y1, to - 0.015).toFixed(3)}`
})
/** The focus box as fractions: hover labels come out scaled by its size. */
const box = computed(() => {
  const [x0 = 0, x1 = 1, y0 = 0, y1 = 1] = focusNow.value.trim().split(/\s+/).map(Number)
  return { x0, x1, y0, y1 }
})

async function run(action: string) {
  const out = slot.value?.action(action)
  status.value = ''
  await nextTick()
  status.value = out ?? (motion.value === 'running' ? 'The drawing is still loading.' : 'Motion is paused. Press Play motion to run it.')
}

/* ── Steps ── */
let raf = 0

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
/** Top of the phone reading band, including the stage leaving the viewport. */
const pinTop = (_el: HTMLElement) => (Number.parseFloat(root.value?.style.getPropertyValue('--stick') ?? '') || window.innerHeight * 0.54) + (stage.value?.getBoundingClientRect().top ?? 0)

function measure() {
  raf = 0
  const items = root.value?.querySelectorAll<HTMLElement>('.chapter-panel')
  if (!items?.length) return
  let p = -1
  if (phone.value) {
    const bandTop = pinTop(items[0]!)
    const panels = items[0]!.parentElement!
    const clip = Math.max(0, bandTop - panels.getBoundingClientRect().top)
    panels.style.setProperty('--panel-clip', `${clip.toFixed(1)}px`)
    // Phones: a panel's step begins when it reaches its pin in the band; the next panel's rise,
    // from the screen's foot to its own pin, carries the fraction between.
    const h = window.innerHeight
    items.forEach((el, i) => {
      if (el.getBoundingClientRect().top > bandTop + 1) return
      p = i
      const next = items[i + 1]
      if (next) p = i + clamp01((h - next.getBoundingClientRect().top) / Math.max(1, h - bandTop))
    })
  }
  else {
    const mid = window.innerHeight * 0.5
    items.forEach((el, i) => {
      const r = el.getBoundingClientRect()
      const centre = r.top + r.height / 2
      if (centre > mid) return
      p = i
      const next = items[i + 1]
      if (next) {
        const n = next.getBoundingClientRect()
        const nc = n.top + n.height / 2
        p = i + clamp01((mid - centre) / Math.max(1, nc - centre))
      }
    })
  }
  emit('progress', Math.max(0, p))
  if (props.tail) {
    const last = items[items.length - 1]!
    const padding = Number.parseFloat(getComputedStyle(last.parentElement!).paddingBottom) || 0
    const anchor = phone.value ? pinTop(last) + last.offsetHeight : window.innerHeight * 0.5 + last.offsetHeight / 2
    const remaining = root.value!.getBoundingClientRect().bottom
    emit('tailProgress', clamp01((anchor + padding - remaining) / (window.innerHeight * 0.8)))
  }
  const step = Math.floor(p)
  if (step === active.value && !missed) return
  active.value = step
  clearTimeout(retry)
  missed = !runStep(step)
  // The scene was still loading, or motion was paused: try again shortly, so
  // the drawing never sits in another step than the panel describes.
  // Only while the drawing can still arrive and the chapter is on screen.
  if (missed && motion.value === 'running' && !unavailable.value && onScreen()) retry = setTimeout(measure, 600)
}

/** Scroll-driven, so silent: a status per scroll step would be noise. False if the step's action could not run. */
function runStep(step: number) {
  const action = step >= 0 ? props.stepActions?.[step] : null
  if (!action) return true
  if (motion.value !== 'running') return false
  return slot.value?.action(action) != null
}

/** The chapter overlaps the viewport (a step retry is only worth it then). */
function onScreen() {
  const r = root.value?.getBoundingClientRect()
  return Boolean(r && r.bottom > 0 && r.top < window.innerHeight)
}

let missed = false
let retry: ReturnType<typeof setTimeout> | undefined

watch(motion, (m) => {
  if (m === 'running' && missed) measure()
})

function onScroll() {
  if (!raf) raf = requestAnimationFrame(measure)
}

/* ── Hover callout ── */
const callout = ref<HTMLElement | null>(null)
let calloutRaf = 0

function drawCallout() {
  calloutRaf = 0
  const el = callout.value
  const l = props.hoverLabel
  if (!el || !l) return
  el.style.opacity = l.visible ? '1' : '0'
  if (l.visible) {
    const { x0, x1, y0, y1 } = box.value
    el.style.transform = `translate(${(l.x / Math.max(0.01, x1 - x0)).toFixed(1)}px, ${(l.y / Math.max(0.01, y1 - y0)).toFixed(1)}px)`
    const t = el.querySelector('.chapter-callout-text')
    if (t && t.textContent !== l.text) t.textContent = l.text
  }
  calloutRaf = requestAnimationFrame(drawCallout)
}

function calloutOn() {
  if (props.hoverLabel && !calloutRaf) calloutRaf = requestAnimationFrame(drawCallout)
}

function calloutOff(e?: PointerEvent) {
  // A finger lifting fires pointerleave on every tap: that must not hide the tap's label.
  if (e?.pointerType === 'touch') return
  cancelAnimationFrame(calloutRaf)
  calloutRaf = 0
  if (callout.value) callout.value.style.opacity = '0'
}

let mq: MediaQueryList | null = null
function measureLayout() {
  measureBand()
  measureDock()
  onScroll()
}

const onMq = () => {
  phone.value = Boolean(mq?.matches)
  measureLayout()
}
// The dock and the panels wrap differently at every width, and the display face arriving late resizes them.
let dockObserver: ResizeObserver | null = null

onMounted(() => {
  mq = window.matchMedia('(max-width: 740px), (max-height: 500px) and (pointer: coarse)')
  onMq()
  mq.addEventListener('change', onMq)
  window.addEventListener('scroll', onScroll, { passive: true })
  dockObserver = new ResizeObserver(measureLayout)
  if (stage.value) dockObserver.observe(stage.value)
  if (dock.value) dockObserver.observe(dock.value)
  root.value?.querySelectorAll<HTMLElement>('.chapter-panel').forEach(el => dockObserver?.observe(el))
  measure()
})

onUnmounted(() => {
  dockObserver?.disconnect()
  mq?.removeEventListener('change', onMq)
  window.removeEventListener('scroll', onScroll)
  cancelAnimationFrame(raf)
  clearTimeout(retry)
  calloutOff()
})
</script>

<template>
  <div ref="root" class="chapter" :class="`panels-${side}`" @pointerenter="calloutOn" @pointerleave="calloutOff">
    <!-- First in reading order, so the section's heading comes before the
         drawing's caption and controls; CSS puts the stage first on screen. -->
    <div class="chapter-panels" data-scene-ignore>
      <slot :active="active" />
    </div>

    <div ref="stage" class="chapter-stage">
      <ThreeSceneSlot
        ref="slot"
        :scene="scene"
        :poster="poster ?? `/img/scenes/${scene}`"
        :poster-version="posterVersion"
        :poster-alt="posterAlt"
        :data-focus="focusNow"
        phone-media="(max-width: 740px), (max-height: 500px) and (pointer: coarse)"
        :poster-position="side === 'left' ? '72% 50%' : '30% 50%'"
        class="chapter-slot"
        input-host=".chapter"
        @unavailable="unavailable = true"
      />
      <div v-if="hoverLabel" ref="callout" class="chapter-callout" aria-hidden="true">
        <span class="chapter-callout-leader" />
        <span class="chapter-callout-text" />
      </div>
      <div ref="dock" class="chapter-dock" data-scene-ignore>
        <p class="chapter-caption">
          <span class="chapter-text">{{ caption }}</span>
          <span v-if="hint && view !== 'reduced' && !unavailable" class="chapter-hint" aria-hidden="true">{{ hint }}</span>
        </p>
        <div v-if="view !== 'reduced' && !unavailable && controls.length" class="chapter-controls" role="group" :aria-label="`Controls for: ${caption}`">
          <button v-for="c in controls" :key="c.action" type="button" class="chip" @click="run(c.action)">{{ c.label }}</button>
        </div>
      </div>
      <p class="visually-hidden" aria-live="polite">{{ status }}</p>
    </div>
  </div>
</template>

<style scoped>
/* The field behind is the chapter's ground; --chapter-ground paints the panels and dock. */
.chapter {
  --chapter-ground: var(--pn-enamel);
  /* Panels come first in the DOM (reading order); the stage is drawn first. */
  display: flex;
  flex-direction: column;
}

.chapter-stage {
  order: 0;
  z-index: 0;
  position: sticky;
  top: 0;
  height: 100vh;
  height: 100svh;
  overflow: hidden;
}

.chapter-slot {
  position: absolute;
  inset: 0;
}

/* The bottom corner of the stage on the drawing's side, just above the
   floating nav: the drawing keeps the screen above it (the focus box stops at
   the dock's top, see measureDock). */
.chapter-dock {
  position: absolute;
  bottom: calc(var(--rail-h) + 1.5rem + env(safe-area-inset-bottom));
  right: clamp(1rem, 2.5vw, 2rem);
  max-width: min(34rem, 56%);
  padding: 0.9rem 1rem;
  background: var(--chapter-ground);
  font-family: var(--font-readout);
}

.panels-right .chapter-dock {
  right: auto;
  left: clamp(1rem, 2.5vw, 2rem);
}

.chapter-caption {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.9rem;
  margin: 0;
}

.chapter-text {
  font-weight: 600;
  font-size: 0.875rem;
  line-height: 1.45;
}

.chapter-hint {
  font-size: 0.8125rem;
  opacity: 0.78;
}

.chapter-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: 0.6rem;
}

/* The panels column: one screen at least, panels spaced so each is read alone. */
.chapter-panels {
  order: 1;
  z-index: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 55vh;
  gap: 55svh;
  min-height: 100vh;
  min-height: 100svh;
  /* Pulled up level with the stage, so they scroll over it. NOT a negative
     margin on the stage: that shrinks its sticky box to nothing and it stays
     pinned a whole screen past the chapter, over the next section. */
  margin-top: -100vh;
  margin-top: -100svh;
  /* Its right edge stays left of the focus box's 0.44 at every width. */
  width: min(34rem, 38%);
  padding: 22svh 0 45svh clamp(1.25rem, 4vw, 4rem);
  pointer-events: none;
}

.panels-right .chapter-panels {
  margin-left: auto;
  padding: 22svh clamp(1.25rem, 4vw, 4rem) 45svh 0;
}

.chapter-panels > :deep(.chapter-panel) {
  padding: clamp(1.5rem, 3vw, 2.5rem);
  pointer-events: auto;
  /* Headings size to the panel, not the screen: a long word ("ELECTRONICS",
     about 10.5em of Dela Gothic One) must never run out of it. */
  container-type: inline-size;
}

.chapter-panels > :deep(.chapter-panel) .display,
.chapter-panels > :deep(.chapter-panel) .display-2 {
  font-size: min(3rem, 9cqi);
}

.chapter-panels > :deep(.chapter-panel) .display-3 {
  font-size: min(2rem, 7cqi);
}

/* A panel may carry its own field colour (.field-blue, .field-yellow, .field-ink). */
.chapter-panels > :deep(.chapter-panel:not([class*='field-'])) {
  background: var(--chapter-ground);
}

/* Callout: origin at the hovered part, leader up and right to a boxed name. */
.chapter-callout {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease-out;
}

.chapter-callout-leader {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 28px;
  height: 1.5px;
  background: var(--pn-ink);
  transform-origin: 0 0;
  transform: rotate(-50deg);
}

.chapter-callout-text {
  position: absolute;
  left: 18px;
  bottom: 22px;
  padding: 3px 8px;
  background: var(--pn-enamel);
  color: var(--pn-ink);
  border: 1.5px solid var(--pn-ink);
  font: 600 11px/1.4 var(--font-readout);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  white-space: nowrap;
}

/* Phones, and short screens (a landscape phone): a compact dock -- one row of
   controls that scrolls sideways, two lines of caption, no hint -- so the box
   leaves the drawing most of the screen. */
@media (max-width: 740px), (max-height: 500px) {
  .chapter-controls {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    /* A scroller clips on both axes: room for the 2px focus ring drawn 3px outside each chip. */
    margin: 0.6rem -6px -6px;
    padding: 6px;
  }

  .chapter-controls .chip {
    flex: none;
  }

  .chapter-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .chapter-hint {
    display: none;
  }

  .chapter-dock {
    padding: 0.6rem 0.75rem;
  }
}

/* Phones: the drawing owns the top of the screen. Text scrolls through the
   band below the dock and is clipped as it passes underneath the drawing. */
@media (max-width: 740px), (max-height: 500px) and (pointer: coarse) {
  /* measureBand() sets each chapter's own --stick in px; this is the first paint's. */
  .chapter {
    --stick: 54svh;
  }

  .chapter-dock {
    top: auto;
    right: 0.75rem;
    left: 0.75rem;
    bottom: calc(100svh - var(--stick) + 0.5rem);
    max-width: none;
  }

  .panels-right .chapter-dock {
    left: 0.75rem;
    right: 0.75rem;
  }

  .chapter-panels,
  .panels-right .chapter-panels {
    /* Text passes below the art rather than covering it or sticking with
       its last lines trapped below the phone's navigation. */
    clip-path: inset(var(--panel-clip, 0px) 0 0);
    width: auto;
    gap: 50svh;
    margin: -100svh 0 0;
    /* Start the first panel below the drawing; reserve space after the last
       line so it can clear the fixed navigation before the stage lets go. */
    padding: var(--stick) 0 12svh;
  }

  .chapter-panels > :deep(.chapter-panel) {
    position: relative;
    top: auto;
    /* Fills the band to the screen's foot, so the panel under it never shows below. */
    min-height: calc(100svh - var(--stick));
    padding: 1.25rem 1.25rem calc(var(--rail-h) + 1.5rem + env(safe-area-inset-bottom));
  }
}
</style>
