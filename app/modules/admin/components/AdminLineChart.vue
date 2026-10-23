<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DayPoint } from '../composables/useInterestAnalytics'

const props = defineProps<{ fig: string, title: string, days: DayPoint[] }>()

const W = 760
const H = 260
const PAD = { l: 36, r: 44, t: 16, b: 28 }
const iw = W - PAD.l - PAD.r
const ih = H - PAD.t - PAD.b

const maxDaily = computed(() => Math.max(1, ...props.days.map(d => d.count)))
const maxCum = computed(() => Math.max(1, ...props.days.map(d => d.cumulative)))
const step = computed(() => iw / Math.max(1, props.days.length))

const x = (i: number) => PAD.l + i * step.value + step.value / 2
const yD = (n: number) => PAD.t + ih - (n / maxDaily.value) * ih
const yC = (n: number) => PAD.t + ih - (n / maxCum.value) * ih

const cumLine = computed(() => props.days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${yC(d.cumulative).toFixed(1)}`).join(''))
const cumArea = computed(() => props.days.length
  ? `${cumLine.value}L${x(props.days.length - 1).toFixed(1)} ${PAD.t + ih}L${x(0).toFixed(1)} ${PAD.t + ih}Z`
  : '')

const ticks = computed(() => {
  const m = maxDaily.value
  return [0, Math.round(m / 2), m].filter((v, i, a) => a.indexOf(v) === i)
})
const labelEvery = computed(() => Math.ceil(props.days.length / 7))

const hover = ref<number | null>(null)
const svg = ref<SVGSVGElement | null>(null)

function onMove(e: PointerEvent) {
  const m = svg.value?.getScreenCTM()
  if (!m) return
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
  const i = Math.floor((p.x - PAD.l) / step.value)
  hover.value = i >= 0 && i < props.days.length ? i : null
}

const tip = computed(() => {
  if (hover.value === null) return null
  const d = props.days[hover.value]!
  return { d, left: `${(x(hover.value) / W) * 100}%` }
})
const total = computed(() => props.days.reduce((a, d) => a + d.count, 0))
</script>

<template>
  <section class="a-panel line-panel">
    <header class="a-head">
      <span class="a-fig">Fig. {{ fig }}</span>
      <h3 class="a-title">{{ title }}</h3>
      <span class="a-meta">{{ total }} in {{ days.length }} days</span>
    </header>
    <div class="line-wrap">
      <svg
        ref="svg"
        class="line-svg"
        :viewBox="`0 0 ${W} ${H}`"
        role="img"
        :aria-label="`${title}: ${total} responses in ${days.length} days`"
        @pointermove="onMove"
        @pointerleave="hover = null"
      >
        <g class="grid">
          <line v-for="t in ticks" :key="t" :x1="PAD.l" :x2="W - PAD.r" :y1="yD(t)" :y2="yD(t)" />
        </g>
        <g class="axis">
          <text v-for="t in ticks" :key="`t${t}`" :x="PAD.l - 8" :y="yD(t) + 4" text-anchor="end">{{ t }}</text>
          <text :x="W - PAD.r + 8" :y="yC(maxCum) + 4" class="cum-label">{{ maxCum }}</text>
          <template v-for="(d, i) in days" :key="d.key">
            <text v-if="i % labelEvery === 0" :x="x(i)" :y="H - 8" text-anchor="middle">{{ d.label }}</text>
          </template>
        </g>
        <path :d="cumArea" class="cum-area" />
        <rect
          v-for="(d, i) in days"
          :key="`b${d.key}`"
          :x="x(i) - step * 0.3"
          :y="yD(d.count)"
          :width="step * 0.6"
          :height="PAD.t + ih - yD(d.count)"
          class="bar"
          :class="{ on: hover === i }"
        />
        <path :d="cumLine" class="cum-line" />
        <line :x1="PAD.l" :x2="W - PAD.r" :y1="PAD.t + ih" :y2="PAD.t + ih" class="base" />
        <g v-if="hover !== null">
          <line :x1="x(hover)" :x2="x(hover)" :y1="PAD.t" :y2="PAD.t + ih" class="cross" />
          <circle :cx="x(hover)" :cy="yC(days[hover]!.cumulative)" r="4" class="cross-dot" />
        </g>
      </svg>
      <div v-if="tip" class="tip" :style="{ left: tip.left }">
        <strong>{{ tip.d.label }}</strong>
        <span>{{ tip.d.count }} new</span>
        <span>{{ tip.d.cumulative }} total</span>
      </div>
    </div>
    <p class="legend">
      <span><i class="lg-bar" /> Daily</span>
      <span><i class="lg-line" /> Running total</span>
    </p>
  </section>
</template>

<style scoped>
.line-wrap { position: relative; }
.line-svg { display: block; width: 100%; height: auto; font-family: var(--font-readout); }
.grid line { stroke: rgba(34, 34, 34, 0.1); stroke-dasharray: 2 4; }
.axis text { font-size: 11px; fill: var(--pn-label); }
.cum-label { fill: var(--color-cyan-text) !important; font-weight: 500; }
.bar { fill: var(--pn-ink); transition: fill 100ms linear; }
.bar.on { fill: var(--color-red-cta); }
.cum-area { fill: rgba(0, 174, 239, 0.1); }
.cum-line { fill: none; stroke: var(--color-cyan); stroke-width: 2; }
.base { stroke: var(--pn-ink); stroke-width: 1.5; }
.cross { stroke: var(--color-cyan); stroke-dasharray: 3 3; }
.cross-dot { fill: #fff; stroke: var(--color-cyan); stroke-width: 2; }
.tip {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  display: grid;
  gap: 0.1rem;
  padding: 0.45rem 0.6rem;
  background: var(--pn-ink);
  color: #fff;
  font-family: var(--font-readout);
  font-size: 0.72rem;
  white-space: nowrap;
  pointer-events: none;
}
.tip strong { font-weight: 500; }
.legend {
  display: flex;
  gap: 1.25rem;
  margin-top: 0.5rem;
  font-family: var(--font-readout);
  font-size: 0.72rem;
  color: var(--pn-label);
}
.legend span { display: inline-flex; align-items: center; gap: 0.4rem; }
.lg-bar { width: 8px; height: 10px; background: var(--pn-ink); }
.lg-line { width: 16px; height: 2px; background: var(--color-cyan); }
</style>
