<script setup lang="ts">
/**
 * Decrypted text (after React Bits' DecryptedText): when the label scrolls
 * into view its characters cycle through glyphs and settle left to right.
 * The server renders the final text, so no-JS and reduced-motion visitors
 * simply see it; the scramble is layered on after hydration.
 */
const props = withDefaults(defineProps<{
  text: string
  /** Total settle time in ms. */
  duration?: number
}>(), { duration: 700 })

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789/#+-'
const shown = ref(props.text)
const el = ref<HTMLElement | null>(null)
let raf = 0
let io: IntersectionObserver | null = null

function scramble() {
  const start = performance.now()
  const final = props.text
  const frame = (now: number) => {
    const p = Math.min(1, (now - start) / props.duration)
    const settled = Math.floor(p * final.length)
    let out = ''
    for (let i = 0; i < final.length; i++) {
      const c = final[i]!
      out += i < settled || c === ' ' ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
    }
    shown.value = out
    raf = p < 1 ? requestAnimationFrame(frame) : 0
  }
  raf = requestAnimationFrame(frame)
}

const { state: motion } = useMotion()

watch(() => props.text, (t) => {
  if (raf) cancelAnimationFrame(raf)
  shown.value = t
  if (import.meta.client && motion.value === 'running') scramble()
})

onMounted(() => {
  if (motion.value !== 'running' || typeof IntersectionObserver === 'undefined') return
  io = new IntersectionObserver(([e]) => {
    if (e?.isIntersecting) {
      scramble()
      io?.disconnect()
    }
  }, { threshold: 0.6 })
  if (el.value) io.observe(el.value)
})

onUnmounted(() => {
  io?.disconnect()
  if (raf) cancelAnimationFrame(raf)
})
</script>

<template>
  <span ref="el" class="decrypt" :aria-label="text"><span aria-hidden="true">{{ shown }}</span></span>
</template>

<style scoped>
.decrypt {
  font-variant-numeric: tabular-nums;
}
</style>
