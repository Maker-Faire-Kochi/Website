<script setup lang="ts">
/**
 * Count up (after React Bits' CountUp): the figure runs from `from` to `to`
 * once it is on screen. The server renders the final figure, so the number
 * is never wrong for no-JS or reduced-motion visitors.
 */
const props = withDefaults(defineProps<{
  to: number
  from?: number
  decimals?: number
  prefix?: string
  suffix?: string
  duration?: number
  /** Group thousands with the viewer's locale. */
  separator?: boolean
}>(), { from: 0, decimals: 0, prefix: '', suffix: '', duration: 1400, separator: false })

const value = ref(props.to)
const el = ref<HTMLElement | null>(null)
let raf = 0
let io: IntersectionObserver | null = null

const text = computed(() => {
  const n = props.separator
    ? value.value.toLocaleString(undefined, { minimumFractionDigits: props.decimals, maximumFractionDigits: props.decimals })
    : value.value.toFixed(props.decimals)
  return `${props.prefix}${n}${props.suffix}`
})

function play() {
  const start = performance.now()
  const frame = (now: number) => {
    const p = Math.min(1, (now - start) / props.duration)
    const eased = 1 - Math.pow(1 - p, 4)
    value.value = props.from + (props.to - props.from) * eased
    raf = p < 1 ? requestAnimationFrame(frame) : 0
  }
  raf = requestAnimationFrame(frame)
}

watch(() => props.to, (v) => {
  if (raf) cancelAnimationFrame(raf)
  value.value = v
})

const { state: motion } = useMotion()

onMounted(() => {
  if (motion.value !== 'running' || typeof IntersectionObserver === 'undefined') return
  io = new IntersectionObserver(([e]) => {
    if (e?.isIntersecting) {
      value.value = props.from
      play()
      io?.disconnect()
    }
  }, { threshold: 0.4 })
  if (el.value) io.observe(el.value)
})

onUnmounted(() => {
  io?.disconnect()
  if (raf) cancelAnimationFrame(raf)
})
</script>

<template>
  <span ref="el" class="count-up">{{ text }}</span>
</template>

<style scoped>
.count-up {
  font-variant-numeric: tabular-nums;
}
</style>
