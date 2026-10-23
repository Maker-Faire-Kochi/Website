<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { CountRow } from '../composables/useInterestAnalytics'

withDefaults(defineProps<{
  fig: string
  title: string
  rows: CountRow[]
  empty?: string
  /** 'cyan' | 'red' | 'ink' bar fill */
  tone?: 'cyan' | 'red' | 'ink'
  limit?: number
}>(), { tone: 'cyan', limit: 12 })

/** Bars draw out from zero once, after first paint. */
const drawn = ref(false)
onMounted(() => requestAnimationFrame(() => { drawn.value = true }))
</script>

<template>
  <section class="a-panel">
    <header class="a-head">
      <span class="a-fig">Fig. {{ fig }}</span>
      <h3 class="a-title">{{ title }}</h3>
    </header>
    <p v-if="!rows.length" class="a-empty">{{ empty || 'No answers yet' }}</p>
    <ol v-else class="bars">
      <li v-for="(row, i) in rows.slice(0, limit)" :key="row.value" class="bar-row">
        <span class="bar-i">{{ String(i + 1).padStart(2, '0') }}</span>
        <span class="bar-label">{{ row.label }}</span>
        <span class="bar-count">{{ row.count }}<span class="pct"> · {{ row.pct }}%</span></span>
        <span class="track" aria-hidden="true">
          <span
            class="fill"
            :class="`fill-${tone}`"
            :style="{ width: drawn ? `${Math.max(row.pct, row.count ? 1.5 : 0)}%` : '0%', transitionDelay: `${i * 40}ms` }"
          />
        </span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.bars { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.7rem; }
.bar-row {
  display: grid;
  grid-template-columns: 1.6rem minmax(0, 1fr) auto;
  column-gap: 0.5rem;
  row-gap: 0.3rem;
  font-family: var(--font-readout);
  font-size: 0.78rem;
}
.bar-i { color: var(--pn-label); }
.bar-label { line-height: 1.35; overflow-wrap: anywhere; }
.bar-count { font-weight: 500; font-variant-numeric: tabular-nums; }
.pct { font-weight: 400; color: var(--pn-label); }
.track { grid-column: 2 / -1; height: 6px; background: rgba(34, 34, 34, 0.06); }
.fill { display: block; height: 100%; transition: width 700ms var(--ease-out); }
.fill-cyan { background: var(--color-cyan); }
.fill-red { background: var(--color-red-cta); }
.fill-ink { background: var(--pn-ink); }
@media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
</style>
