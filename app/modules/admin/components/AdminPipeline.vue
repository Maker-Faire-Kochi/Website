<script setup lang="ts">
import type { CountRow } from '../composables/useInterestAnalytics'

defineProps<{ fig: string, title: string, rows: CountRow[] }>()

const COLORS: Record<string, string> = { new: '#C4121A', reviewed: '#00AEEF', contacted: '#222222', archived: '#BDBDBD' }
</script>

<template>
  <section class="a-panel">
    <header class="a-head">
      <span class="a-fig">Fig. {{ fig }}</span>
      <h3 class="a-title">{{ title }}</h3>
    </header>
    <div class="pipe" role="img" :aria-label="rows.map(r => `${r.label} ${r.count}`).join(', ')">
      <span
        v-for="r in rows"
        :key="r.value"
        class="pipe-seg"
        :style="{ flexGrow: r.count || 0.0001, background: COLORS[r.value] }"
        :title="`${r.label}: ${r.count}`"
      />
    </div>
    <ol class="pipe-steps">
      <li v-for="(r, i) in rows" :key="r.value">
        <span class="pipe-i">{{ String(i + 1).padStart(2, '0') }}</span>
        <i :style="{ background: COLORS[r.value] }" />
        <span class="pipe-label">{{ r.label }}</span>
        <strong class="pipe-n">{{ r.count }}</strong>
        <span class="pipe-pct">{{ r.pct }}%</span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.pipe { display: flex; gap: 2px; height: 18px; margin-bottom: 1rem; background: rgba(34, 34, 34, 0.05); }
.pipe-seg { flex-basis: 0; min-width: 0; transition: flex-grow 600ms var(--ease-out); }
.pipe-steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr)); gap: 0.75rem; }
.pipe-steps li {
  display: grid;
  grid-template-columns: auto 8px 1fr;
  grid-template-rows: auto auto;
  column-gap: 0.45rem;
  align-items: center;
  padding-top: 0.5rem;
  border-top: 1px solid var(--pn-ink);
  font-family: var(--font-readout);
  font-size: 0.72rem;
}
.pipe-i { color: var(--pn-label); }
.pipe-steps i { width: 8px; height: 8px; }
.pipe-label { text-transform: uppercase; letter-spacing: 0.06em; }
.pipe-n { grid-column: 1 / 3; font-family: var(--font-panel); font-weight: 400; font-size: 1.9rem; line-height: 1.1; }
.pipe-pct { align-self: end; padding-bottom: 0.35rem; color: var(--pn-label); }
</style>
