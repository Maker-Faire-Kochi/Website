<script setup lang="ts">
import { heroAnchors } from '~/three/core/signal'

/**
 * Balloons, as on a general-arrangement drawing: each robot carries a numbered
 * balloon on a short leader from its head, matching the "Key to drawing"
 * (01 Makey, 02 duck walker, 03 wheel-legged balancer, 04 robot dog: by the
 * anchor id's prefix), and the balloons follow the robots live. The hero scene
 * publishes each head's position in heroAnchors, in its FOCUS box's frame
 * (see fit() in stage.ts), so it is scaled back to the slot here.
 *
 * Kept short and up-and-away from the head on purpose: an earlier version ran
 * leaders from the key to the robots and they crossed the headline. These stay
 * inside the drawing bay, which no text overlaps.
 *
 * Decorative (aria-hidden): the key is the text. Drawn only while the hero is
 * on screen; while motion is paused it redraws on scroll/resize only.
 */
const MAX = 6
const NUMBERS: [string, string][] = [['makey', '01'], ['duck', '02'], ['balancer', '03'], ['wheel', '03'], ['dog', '04']]
const svg = ref<SVGSVGElement | null>(null)
const { state: motion } = useMotion()

let raf = 0
let visible = false
let io: IntersectionObserver | null = null

function draw() {
  raf = 0
  const el = svg.value
  const hero = el?.closest('.hero') as HTMLElement | null
  const slot = hero?.querySelector('.hero-stage') as HTMLElement | null
  if (!el || !hero || !slot) return
  // Measured against the SVG's own box, so it is right wherever it is placed.
  const h = el.getBoundingClientRect()
  const s = slot.getBoundingClientRect()
  const [x0 = 0, x1 = 1, y0 = 0, y1 = 1] = (slot.dataset.focus || '0 1 0 1').trim().split(/\s+/).map(Number)
  const sx = 1 / Math.max(0.01, x1 - x0)
  const sy = 1 / Math.max(0.01, y1 - y0)
  const groups = el.querySelectorAll<SVGGElement>('.hl-b')
  for (let i = 0; i < MAX; i++) {
    const g = groups[i]
    const a = heroAnchors[i]
    if (!g) continue
    if (!a || !a.visible) {
      g.style.display = 'none'
      continue
    }
    const ax = s.left - h.left + a.x * sx
    const ay = s.top - h.top + a.y * sy
    const bx = ax + 26
    const by = ay - 34
    g.style.display = ''
    g.querySelector('line')?.setAttribute('x1', (ax + 3).toFixed(1))
    g.querySelector('line')?.setAttribute('y1', (ay - 4).toFixed(1))
    g.querySelector('line')?.setAttribute('x2', (bx - 8).toFixed(1))
    g.querySelector('line')?.setAttribute('y2', (by + 8).toFixed(1))
    g.querySelector('circle')?.setAttribute('transform', `translate(${bx.toFixed(1)} ${by.toFixed(1)})`)
    const t = g.querySelector('text')
    if (t) {
      t.setAttribute('x', bx.toFixed(1))
      t.setAttribute('y', (by + 4).toFixed(1))
      const n = NUMBERS.find(([p]) => a.id.startsWith(p))?.[1] ?? ''
      if (t.textContent !== n) t.textContent = n
    }
  }
  if (visible && motion.value === 'running') raf = requestAnimationFrame(draw)
}

function kick() {
  if (!raf) raf = requestAnimationFrame(draw)
}

onMounted(() => {
  io = new IntersectionObserver(([e]) => {
    visible = Boolean(e?.isIntersecting)
    if (visible) kick()
  })
  const hero = svg.value?.closest('.hero')
  if (hero) io.observe(hero)
  window.addEventListener('scroll', kick, { passive: true })
  window.addEventListener('resize', kick, { passive: true })
})

watch(motion, kick)

onUnmounted(() => {
  cancelAnimationFrame(raf)
  io?.disconnect()
  window.removeEventListener('scroll', kick)
  window.removeEventListener('resize', kick)
})
</script>

<template>
  <svg ref="svg" class="hero-leaders" aria-hidden="true">
    <g v-for="i in MAX" :key="i" class="hl-b" style="display: none">
      <line />
      <circle r="11" />
      <text text-anchor="middle" />
    </g>
  </svg>
</template>

<style scoped>
.hero-leaders {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
  z-index: 0;
}

.hl-b line {
  stroke: var(--pn-ink);
  stroke-width: 1;
}

.hl-b circle {
  fill: var(--pn-enamel);
  stroke: var(--color-cyan);
  stroke-width: 1.5;
}

.hl-b text {
  font: 500 10px var(--font-readout);
  fill: var(--pn-ink);
}

/* On the stacked phone sheet the drawing is small; the balloons would crowd it. */
@media (max-width: 740px), (max-height: 600px) {
  .hero-leaders {
    display: none;
  }
}
</style>
