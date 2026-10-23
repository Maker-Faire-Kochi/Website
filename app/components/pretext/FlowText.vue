<script setup lang="ts">
/**
 * Experimental: a paragraph that re-wraps around the pointer, live.
 *
 * Pretext (@chenglou/pretext) lays the lines out in pure arithmetic over
 * cached glyph widths -- no DOM measurement, no reflow -- so the whole
 * paragraph can be re-broken every frame. Each line is routed with
 * layoutNextLineRange(): where a line's band crosses the circle around the
 * pointer, that line starts after the circle (or stops before it, whichever
 * side has more room), like text flowing around a figure on a drawing.
 *
 * The real <p> stays in the DOM, in place and in the accessibility tree (it
 * goes transparent, not hidden, while the lines are drawn over it), so screen
 * readers, find-in-page and copy all see one ordinary paragraph. Only on a fine
 * pointer with motion running; otherwise it IS that ordinary paragraph.
 */
const props = defineProps<{ text: string, tag?: string }>()

const real = ref<HTMLElement | null>(null)
const lines = ref<{ x: number, y: number, text: string }[]>([])
const active = ref(false)
const height = ref(0)
const { state: motion } = useMotion()

const RADIUS = 64
const PAD = 10
const MIN_LINE = 48

let pretext: typeof import('@chenglou/pretext') | null = null
let prepared: any = null
let lineHeight = 24
let width = 0
let raf = 0
let target = { x: 0, y: 0, r: 0 }
const ob = { x: 0, y: 0, r: 0 }

function prepare() {
  const el = real.value
  if (!pretext || !el) return
  const cs = getComputedStyle(el)
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const spacing = Number.parseFloat(cs.letterSpacing)
  prepared = pretext.prepareWithSegments(props.text, font, Number.isFinite(spacing) ? { letterSpacing: spacing } : undefined)
  lineHeight = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.6
  width = el.clientWidth
}

function layout() {
  if (!pretext || !prepared) return
  const out: { x: number, y: number, text: string }[] = []
  let cursor = { segmentIndex: 0, graphemeIndex: 0 }
  let y = 0
  for (let guard = 0; guard < 200; guard++) {
    let x = 0
    let w = width
    if (ob.r > 1) {
      // Distance from the circle's centre to this line's band, then the
      // half-chord the circle cuts across the band.
      const top = y
      const bottom = y + lineHeight
      const dy = ob.y < top ? top - ob.y : ob.y > bottom ? ob.y - bottom : 0
      if (dy < ob.r) {
        const half = Math.sqrt(ob.r * ob.r - dy * dy) + PAD
        const left = Math.max(0, ob.x - half)
        const right = Math.max(0, width - (ob.x + half))
        if (left >= right) w = left
        else {
          x = width - right
          w = right
        }
      }
    }
    if (w < MIN_LINE) {
      y += lineHeight
      continue
    }
    const range = pretext.layoutNextLineRange(prepared, w, cursor)
    if (range === null) break
    out.push({ x, y, text: pretext.materializeLineRange(prepared, range).text })
    cursor = range.end
    y += lineHeight
  }
  lines.value = out
  height.value = y
}

function frame() {
  raf = 0
  // Ease the obstacle: it grows in, drifts after the pointer, and shrinks away.
  ob.x += (target.x - ob.x) * 0.3
  ob.y += (target.y - ob.y) * 0.3
  ob.r += (target.r - ob.r) * 0.2
  if (ob.r < 0.5 && target.r === 0) {
    ob.r = 0
    active.value = false
    return
  }
  active.value = true
  layout()
  raf = requestAnimationFrame(frame)
}

function onMove(e: PointerEvent) {
  const el = real.value
  if (!el || !prepared || motion.value !== 'running' || e.pointerType === 'touch') return
  const r = el.getBoundingClientRect()
  const x = e.clientX - r.left
  const y = e.clientY - r.top
  // Only while the pointer is over the paragraph or close to it.
  const near = x > -RADIUS && x < r.width + RADIUS && y > -RADIUS && y < r.height + RADIUS
  target = near ? { x, y, r: RADIUS } : { ...target, r: 0 }
  if (near && ob.r === 0) {
    ob.x = x
    ob.y = y
  }
  if (!raf && (near || ob.r > 0)) raf = requestAnimationFrame(frame)
}

let ro: ResizeObserver | null = null

onMounted(async () => {
  if (!matchMedia('(pointer: fine)').matches) return
  await document.fonts?.ready
  pretext = await import('@chenglou/pretext')
  prepare()
  ro = new ResizeObserver(() => {
    if (!real.value) return
    width = real.value.clientWidth
  })
  if (real.value) ro.observe(real.value)
  window.addEventListener('pointermove', onMove, { passive: true })
})

watch(motion, (m) => {
  if (m !== 'running') {
    target = { ...target, r: 0 }
    ob.r = 0
    active.value = false
  }
})

onUnmounted(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
  window.removeEventListener('pointermove', onMove)
})
</script>

<template>
  <div class="flow" :style="active ? { minHeight: `${height}px` } : undefined">
    <component :is="tag ?? 'p'" ref="real" class="flow-real" :class="{ 'is-covered': active }"><slot>{{ text }}</slot></component>
    <div v-if="active" class="flow-lines" aria-hidden="true">
      <span v-for="(l, i) in lines" :key="i" class="flow-line" :style="{ transform: `translate(${l.x}px, ${l.y}px)` }">{{ l.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.flow {
  position: relative;
}

/* Inherit everything from the paragraph's own classes; the lines must match it exactly. */
.flow-real {
  margin: 0;
  font: inherit;
  color: inherit;
  letter-spacing: inherit;
  line-height: inherit;
}

.flow-real.is-covered {
  opacity: 0;
}

.flow-lines {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.flow-line {
  position: absolute;
  left: 0;
  top: 0;
  white-space: pre;
}
</style>
