<script setup lang="ts">
import type { SceneName } from '~/three/scenes'

/**
 * A live figure on a field: the 3D scene drawn directly on the section's
 * colour, a caption, and the keyboard equivalents of every pointer
 * interaction in the scene (WCAG 2.1.1) as chips, their result announced in
 * a polite live region. The canvas is decorative (aria-hidden); the caption
 * says what is drawn. Colours follow the field (currentColor).
 */
const props = withDefaults(defineProps<{
  scene: SceneName
  caption: string
  hint?: string
  controls: { action: string, label: string }[]
  poster?: string
  /** CSS aspect-ratio of the drawing on wide screens and on phones. */
  aspect?: string
  phoneAspect?: string
  /**
   * A scene's live hover label (its own label.ts: { text, x, y, visible },
   * slot-relative px), drawn as a callout: a leader up from the part to a
   * boxed name. Read in rAF only while the pointer is over the figure.
   */
  hoverLabel?: { text: string, x: number, y: number, visible: boolean }
}>(), { aspect: '16 / 7', phoneAspect: '4 / 3' })

const { state: motion, view } = useMotion()
const slot = ref<{ action: (name: string) => string | null } | null>(null)
const status = ref('')
/** The live drawing will never run for this visitor (Save-Data, no WebGL): no controls, no hint. */
const unavailable = ref(false)

async function run(action: string) {
  const out = slot.value?.action(action)
  // Cleared first so the same status twice ("Busy") is announced twice.
  status.value = ''
  await nextTick()
  status.value = out ?? (motion.value === 'running' ? 'The drawing is still loading.' : 'Motion is paused. Press Play motion to run it.')
}

const callout = ref<HTMLElement | null>(null)
let calloutRaf = 0

function drawCallout() {
  calloutRaf = 0
  const el = callout.value
  const l = props.hoverLabel
  if (!el || !l) return
  el.style.opacity = l.visible ? '1' : '0'
  if (l.visible) {
    el.style.transform = `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px)`
    const t = el.querySelector('.fig-callout-text')
    if (t && t.textContent !== l.text) t.textContent = l.text
  }
  calloutRaf = requestAnimationFrame(drawCallout)
}

function calloutOn() {
  if (props.hoverLabel && !calloutRaf) calloutRaf = requestAnimationFrame(drawCallout)
}

function calloutOff() {
  cancelAnimationFrame(calloutRaf)
  calloutRaf = 0
  if (callout.value) callout.value.style.opacity = '0'
}

onUnmounted(calloutOff)
</script>

<template>
  <figure class="fig scene-band" :style="{ '--fig-aspect': aspect, '--fig-aspect-phone': phoneAspect }" @pointerenter="calloutOn" @pointerleave="calloutOff">
    <div class="fig-stage-wrap">
      <ThreeSceneSlot
        ref="slot"
        :scene="props.scene"
        :poster="poster ?? `/img/scenes/${props.scene}`"
        class="fig-stage"
        input-host=".fig"
        @unavailable="unavailable = true"
      />
      <div v-if="hoverLabel" ref="callout" class="fig-callout" aria-hidden="true">
        <span class="fig-callout-leader" />
        <span class="fig-callout-text" />
      </div>
    </div>
    <figcaption class="fig-caption" data-scene-ignore>
      <span class="fig-text">{{ caption }}</span>
      <span v-if="hint && view !== 'reduced' && !unavailable" class="fig-hint" aria-hidden="true">{{ hint }}</span>
    </figcaption>
    <div v-if="view !== 'reduced' && !unavailable && controls.length" class="fig-controls" role="group" :aria-label="`Controls for: ${caption}`" data-scene-ignore>
      <button v-for="c in controls" :key="c.action" type="button" class="chip" @click="run(c.action)">{{ c.label }}</button>
    </div>
    <p class="visually-hidden" aria-live="polite">{{ status }}</p>
  </figure>
</template>

<style scoped>
.fig {
  margin: 0;
}

.fig-stage-wrap {
  position: relative;
}

.fig-stage {
  aspect-ratio: var(--fig-aspect);
}

.fig-caption {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.3rem 1rem;
  padding-top: 0.9rem;
  border-top: 2px solid currentColor;
  font-family: var(--font-readout);
}

.fig-text {
  font-weight: 600;
  font-size: 0.9375rem;
  line-height: 1.45;
}

.fig-hint {
  font-size: 0.875rem;
  opacity: 0.78;
}

.fig-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.75rem;
}

/* Callout: origin at the hovered part, leader up and right to a boxed name. */
.fig-callout {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 2;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease-out;
}

.fig-callout-leader {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 28px;
  height: 1.5px;
  background: currentColor;
  transform-origin: 0 0;
  transform: rotate(-50deg);
}

.fig-callout-text {
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

@media (max-width: 740px) {
  .fig-stage {
    aspect-ratio: var(--fig-aspect-phone);
  }
}
</style>
