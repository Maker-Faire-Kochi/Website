<script setup lang="ts">
import { noiseSignal } from '~/three/core/signal'

/**
 * Experimental: the campaign's headline, MAKE SOME NOISE, where the word NOISE
 * deforms as a controlled signal -- the Make Some Noise campaign's one graphic
 * idea, now driven by real sound.
 *
 * Pretext breaks the headline into lines at the container width with Anton's
 * real metrics (prepareWithSegments + layoutWithLines), and canvas measureText
 * gives each glyph's x within its line, so every letter can be placed and moved
 * on its own without the DOM ever measuring anything. At rest NOISE carries a
 * fixed waveform (the poster's shape); while the noise machine plays, the
 * amplitude and travel follow the synth's actual output level (noiseSignal,
 * written by the noise scene's AnalyserNode).
 *
 * Accessible name: the real text, visually hidden. Server render and no-JS:
 * the plain headline. Reduced motion or Pause: the static shape only.
 */
const props = defineProps<{ text: string, word?: string }>()

const box = ref<HTMLElement | null>(null)
const glyphs = ref<{ ch: string, x: number, y: number, wave: number }[]>([])
const ready = ref(false)
const heightPx = ref(0)
const { state: motion } = useMotion()

let raf = 0
let ro: ResizeObserver | null = null
let pretext: typeof import('@chenglou/pretext') | null = null
let fontSize = 64
let t = 0
let last = 0
let level = 0

function build() {
  const el = box.value
  if (!el || !pretext) return
  const cs = getComputedStyle(el)
  const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  fontSize = Number.parseFloat(cs.fontSize)
  const lh = Number.parseFloat(cs.lineHeight) || fontSize * 1.02
  const text = props.text.toUpperCase()
  const prepared = pretext.prepareWithSegments(text, font)
  const { lines } = pretext.layoutWithLines(prepared, el.clientWidth, lh)
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.font = font
  const word = (props.word ?? 'NOISE').toUpperCase()
  const out: typeof glyphs.value = []
  lines.forEach((line, li) => {
    const start = line.text.indexOf(word)
    for (let i = 0; i < line.text.length; i++) {
      const ch = line.text[i]!
      if (ch === ' ') continue
      // Index within the deforming word, or -1 for every other letter.
      const w = start >= 0 && i >= start && i < start + word.length ? i - start : -1
      out.push({ ch, x: ctx.measureText(line.text.slice(0, i)).width, y: li * lh, wave: w })
    }
  })
  glyphs.value = out
  heightPx.value = lines.length * lh
  ready.value = true
  paint()
}

/** The waveform: a fixed shape at rest, grown and set travelling by the live level. */
function offset(i: number) {
  const base = Math.sin(i * 1.15 + 0.6) * 0.07
  const live = Math.sin(i * 1.15 + t * 7) * level * 0.28
  return (base + live) * fontSize
}

function paint() {
  const el = box.value
  if (!el) return
  const spans = el.querySelectorAll<HTMLElement>('.nh-g')
  glyphs.value.forEach((g, i) => {
    const s = spans[i]
    if (!s) return
    if (g.wave < 0) {
      s.style.transform = `translate(${g.x}px, ${g.y}px)`
      return
    }
    const dy = offset(g.wave)
    const stretch = 1 + Math.abs(dy) / fontSize * 1.4
    s.style.transform = `translate(${g.x}px, ${g.y + dy}px) scaleY(${stretch.toFixed(3)})`
  })
}

function frame(now: number) {
  raf = 0
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
  last = now
  t += dt
  // Smooth the level so the letters breathe with the sound instead of jittering.
  level += ((noiseSignal.active ? noiseSignal.level : 0) - level) * Math.min(1, dt * 10)
  paint()
  if (motion.value === 'running') raf = requestAnimationFrame(frame)
}

function start() {
  if (!raf && ready.value && motion.value === 'running') {
    last = 0
    raf = requestAnimationFrame(frame)
  }
}

let io: IntersectionObserver | null = null

onMounted(async () => {
  await document.fonts?.ready
  pretext = await import('@chenglou/pretext')
  await nextTick()
  build()
  ro = new ResizeObserver(() => build())
  if (box.value) ro.observe(box.value)
  // Only animate while on screen.
  io = new IntersectionObserver(([e]) => {
    if (e?.isIntersecting) start()
    else {
      cancelAnimationFrame(raf)
      raf = 0
    }
  })
  if (box.value) io.observe(box.value)
})

watch(motion, (m) => {
  if (m === 'running') start()
  else {
    cancelAnimationFrame(raf)
    raf = 0
    level = 0
    paint()
  }
})

onUnmounted(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
  io?.disconnect()
})
</script>

<template>
  <span ref="box" class="nh" :style="ready ? { height: `${heightPx}px` } : undefined">
    <template v-if="ready">
      <span class="visually-hidden">{{ text }}</span>
      <span class="nh-layer" aria-hidden="true">
        <span v-for="(g, i) in glyphs" :key="i" class="nh-g" :class="{ 'is-wave': g.wave >= 0 }">{{ g.ch }}</span>
      </span>
    </template>
    <template v-else>{{ text }}</template>
  </span>
</template>

<style scoped>
.nh {
  position: relative;
  display: block;
}

.nh-layer {
  position: absolute;
  inset: 0;
}

.nh-g {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 50% 60%;
  white-space: pre;
}

/* The deforming word carries the campaign's electric blue. */
.nh-g.is-wave {
  color: var(--beam-accent);
}
</style>
