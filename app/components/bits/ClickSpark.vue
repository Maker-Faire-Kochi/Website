<script setup lang="ts">
/**
 * Click spark (after React Bits' ClickSpark): a burst of short rays where a
 * key or a machine is pressed. One fixed canvas for the page; it only
 * draws while a burst is alive, and is skipped under reduced motion.
 */
const props = withDefaults(defineProps<{
  /** Elements that spark when pressed. */
  selector?: string
  count?: number
  radius?: number
}>(), { selector: '.key, .machine, .spark', count: 9, radius: 22 })

interface Spark { x: number, y: number, a: number, t0: number, color: string }

const canvas = ref<HTMLCanvasElement | null>(null)
const sparks: Spark[] = []
let raf = 0
const COLORS = ['#00AEEF', '#222222', '#ED1C24']

function resize() {
  const c = canvas.value
  if (!c) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  c.width = window.innerWidth * dpr
  c.height = window.innerHeight * dpr
  c.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function draw(now: number) {
  const c = canvas.value
  const ctx = c?.getContext('2d')
  if (!c || !ctx) return
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)
  const LIFE = 420
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i]!
    const p = (now - s.t0) / LIFE
    if (p >= 1) { sparks.splice(i, 1); continue }
    const e = 1 - Math.pow(1 - p, 3)
    const d = e * props.radius
    const len = 9 * (1 - e)
    ctx.strokeStyle = s.color
    ctx.lineWidth = 2
    ctx.lineCap = 'square'
    ctx.beginPath()
    ctx.moveTo(s.x + Math.cos(s.a) * d, s.y + Math.sin(s.a) * d)
    ctx.lineTo(s.x + Math.cos(s.a) * (d + len), s.y + Math.sin(s.a) * (d + len))
    ctx.stroke()
  }
  raf = sparks.length ? requestAnimationFrame(draw) : 0
}

function onDown(e: PointerEvent) {
  if (e.button !== 0 || motion.value !== 'running') return
  if (!(e.target as Element | null)?.closest?.(props.selector)) return
  const now = performance.now()
  const color = COLORS[Math.floor(Math.random() * COLORS.length)]!
  for (let i = 0; i < props.count; i++) {
    sparks.push({ x: e.clientX, y: e.clientY, a: (i / props.count) * Math.PI * 2, t0: now, color })
  }
  if (!raf) raf = requestAnimationFrame(draw)
}

const { state: motion } = useMotion()

onMounted(() => {
  if (motion.value === 'reduced') return
  resize()
  window.addEventListener('resize', resize)
  document.addEventListener('pointerdown', onDown)
})

onUnmounted(() => {
  window.removeEventListener('resize', resize)
  document.removeEventListener('pointerdown', onDown)
  if (raf) cancelAnimationFrame(raf)
})
</script>

<template>
  <canvas ref="canvas" class="click-spark" aria-hidden="true" />
</template>

<style scoped>
.click-spark {
  position: fixed;
  inset: 0;
  z-index: 200;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
}
</style>
