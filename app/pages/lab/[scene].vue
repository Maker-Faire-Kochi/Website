<script setup lang="ts">
import { isSceneName } from '~/three/scenes'
import { heroKeepOut } from '~/three/core/signal'

/**
 * Dev-only lab: one scene, full viewport, with live stage stats. Every scene is
 * signed off here (full size, a 96px thumbnail, fallbacks, frame time) before
 * it is placed on the homepage. Production builds answer 404.
 *
 *   /lab/<scene>            the scene
 *   /lab/<scene>?poster=1   deterministic still pose; sets window.__posterReady
 *   /lab/hero?keepout=x0,x1,y0,y1;...   the hero's text keep-out rects (fractions of the
 *                           slot), as the homepage publishes them; set before the scene is built
 *   /lab/<scene>?focus=0.4+1+0+1   frame for a focus box, as on the homepage's
 *                           full-bleed chapters (see fit() in stage.ts); the box is outlined
 */
if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found', fatal: true })

definePageMeta({ layout: false })

const route = useRoute()
const name = String(route.params.scene)
if (!isSceneName(name)) throw createError({ statusCode: 404, statusMessage: `No scene "${name}"`, fatal: true })

// Poster capture: a transparent page, so the poster carries alpha and sits on
// whatever paper the live page has (scripts/render-poster.mjs).
if (route.query.poster) useHead({ style: [{ innerHTML: 'html { background: transparent !important; } #nuxt-devtools-container, #nuxt-devtools-anchor { display: none !important; }' }] })

const focus = typeof route.query.focus === 'string' ? route.query.focus : undefined

if (import.meta.client && typeof route.query.keepout === 'string') {
  heroKeepOut.rects = route.query.keepout.split(';').map(q => q.split(',').map(Number)).filter(v => v.length === 4 && v.every(Number.isFinite)).map(([x0, x1, y0, y1]) => ({ x0: x0!, x1: x1!, y0: y0!, y1: y1! }))
  heroKeepOut.version++
}
const box = focus?.trim().split(/\s+/).map(Number)

const stats = ref('')
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  timer = setInterval(() => {
    const s = (window as any).__stage?.stats()
    if (!s) return
    const ms = [...s.frameMs].sort((a: number, b: number) => a - b)
    const p95 = ms.length ? ms[Math.floor(ms.length * 0.95)].toFixed(1) : '-'
    stats.value = `calls ${s.calls}  tris ${s.triangles}  p95 ${p95}ms  dropped ${s.dropped}`
  }, 500)
})

onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <main class="lab maker-app">
    <ThreeSceneSlot :scene="name" class="lab-slot" input-host=".lab" :data-focus="focus" />
    <div
      v-if="box && !route.query.poster"
      class="lab-focus"
      :style="{ left: `${box[0]! * 100}%`, right: `${(1 - box[1]!) * 100}%`, top: `${(box[2] ?? 0) * 100}%`, bottom: `${(1 - (box[3] ?? 1)) * 100}%` }"
    />
    <ThreeSceneSlot v-if="!route.query.poster" :scene="name" class="lab-thumb" />
    <pre v-if="!route.query.poster" class="lab-stats">{{ name }}  {{ stats }}</pre>
  </main>
</template>

<style scoped>
.lab {
  position: relative;
  min-height: 100vh;
}

.lab-slot {
  position: absolute;
  inset: 0;
}

/* The same scene again at thumbnail size: the guidelines' silhouette check. */
.lab-thumb {
  position: absolute;
  right: 16px;
  bottom: 48px;
  width: 96px;
  height: 96px;
  outline: 1px solid var(--pn-faint);
}

.lab-focus {
  position: absolute;
  outline: 1px dashed var(--pn-ink);
  pointer-events: none;
}

.lab-stats {
  position: fixed;
  left: 16px;
  bottom: 12px;
  margin: 0;
  font: 500 12px/1.4 var(--font-readout);
  color: var(--pn-ink);
}
</style>
