<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CountRow } from '../composables/useInterestAnalytics'

const props = defineProps<{ fig: string, title: string, rows: CountRow[] }>()

const PALETTE = ['#222222', '#00AEEF', '#C4121A', '#8C8C8C', '#7FD6F7', '#555555', '#F2A5A8']
const R = 52
const C = 2 * Math.PI * R

const total = computed(() => props.rows.reduce((a, r) => a + r.count, 0))
const segs = computed(() => {
  let acc = 0
  return props.rows.map((r, i) => {
    const len = total.value ? (r.count / total.value) * C : 0
    const seg = { ...r, color: PALETTE[i % PALETTE.length], dash: `${Math.max(0, len - 2)} ${C}`, offset: -acc }
    acc += len
    return seg
  })
})
const hover = ref<string | null>(null)
const centre = computed(() => {
  const h = props.rows.find(r => r.value === hover.value)
  return h ? { n: h.count, l: `${h.pct}%` } : { n: total.value, l: 'Total' }
})
</script>

<template>
  <section class="a-panel">
    <header class="a-head">
      <span class="a-fig">Fig. {{ fig }}</span>
      <h3 class="a-title">{{ title }}</h3>
    </header>
    <p v-if="!rows.length" class="a-empty">No answers yet</p>
    <div v-else class="donut">
      <svg viewBox="-70 -70 140 140" class="donut-svg" role="img" :aria-label="title">
        <circle :r="R" class="donut-track" />
        <circle
          v-for="s in segs"
          :key="s.value"
          :r="R"
          class="donut-seg"
          :class="{ dim: hover && hover !== s.value }"
          :stroke="s.color"
          :stroke-dasharray="s.dash"
          :stroke-dashoffset="s.offset"
          transform="rotate(-90)"
          @pointerenter="hover = s.value"
          @pointerleave="hover = null"
        />
        <text y="2" text-anchor="middle" class="donut-n">{{ centre.n }}</text>
        <text y="18" text-anchor="middle" class="donut-l">{{ centre.l }}</text>
      </svg>
      <ul class="donut-legend">
        <li
          v-for="s in segs"
          :key="s.value"
          :class="{ dim: hover && hover !== s.value }"
          @pointerenter="hover = s.value"
          @pointerleave="hover = null"
        >
          <i :style="{ background: s.color }" />
          <span class="lg-label">{{ s.label }}</span>
          <span class="lg-n">{{ s.count }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.donut { display: flex; flex-wrap: wrap; justify-content: center; gap: 1.25rem; align-items: center; }
.donut-svg { flex: 0 0 9rem; width: 9rem; height: auto; overflow: visible; }
.donut-legend { flex: 1 1 12rem; min-width: 0; }
.donut-track { fill: none; stroke: rgba(34, 34, 34, 0.06); stroke-width: 16; }
.donut-seg { fill: none; stroke-width: 16; transition: opacity 120ms linear, stroke-width 120ms; cursor: default; }
.donut-seg.dim { opacity: 0.25; }
.donut-n { font-family: var(--font-panel); font-weight: 400; font-size: 26px; fill: var(--pn-ink); }
.donut-l { font-family: var(--font-readout); font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; fill: var(--pn-label); }
.donut-legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; }
.donut-legend li {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto;
  gap: 0.6rem;
  align-items: center;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid rgba(34, 34, 34, 0.1);
  font-family: var(--font-readout);
  font-size: 0.78rem;
  transition: opacity 120ms linear;
}
.donut-legend li.dim { opacity: 0.35; }
.donut-legend i { width: 10px; height: 10px; }
.lg-label { line-height: 1.35; overflow-wrap: anywhere; }
.lg-n { font-variant-numeric: tabular-nums; font-weight: 500; }
</style>
