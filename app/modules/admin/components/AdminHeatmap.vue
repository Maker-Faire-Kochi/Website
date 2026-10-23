<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ fig: string, title: string, grid: number[][] }>()

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const max = computed(() => Math.max(1, ...props.grid.flat()))
const peak = computed(() => {
  let best = { d: 0, h: 0, n: 0 }
  props.grid.forEach((row, d) => row.forEach((n, h) => { if (n > best.n) best = { d, h, n } }))
  return best
})
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
</script>

<template>
  <section class="a-panel">
    <header class="a-head">
      <span class="a-fig">Fig. {{ fig }}</span>
      <h3 class="a-title">{{ title }}</h3>
      <span v-if="peak.n" class="a-meta">Peak {{ DAYS[peak.d] }} {{ hh(peak.h) }}</span>
    </header>
    <div class="heat" role="img" :aria-label="`${title}. Busiest: ${DAYS[peak.d]} ${hh(peak.h)}`">
      <span />
      <span v-for="h in 24" :key="`h${h}`" class="heat-h">{{ (h - 1) % 6 === 0 ? String(h - 1).padStart(2, '0') : '' }}</span>
      <template v-for="(row, d) in grid" :key="d">
        <span class="heat-d">{{ DAYS[d] }}</span>
        <span
          v-for="(n, h) in row"
          :key="h"
          class="heat-cell"
          :title="`${DAYS[d]} ${hh(h)}: ${n}`"
          :style="{ '--a': n ? 0.15 + (n / max) * 0.85 : 0 }"
        />
      </template>
    </div>
    <p class="heat-scale" aria-hidden="true">
      Fewer <i v-for="k in 5" :key="k" :style="{ '--a': 0.15 + (k / 5) * 0.85 }" /> More
    </p>
  </section>
</template>

<style scoped>
.heat {
  display: grid;
  grid-template-columns: 2.25rem repeat(24, minmax(0, 1fr));
  gap: 3px;
  font-family: var(--font-readout);
  font-size: 0.66rem;
  color: var(--pn-label);
}
.heat-h { text-align: left; }
.heat-d { align-self: center; }
.heat-cell,
.heat-scale i {
  aspect-ratio: 1;
  background: rgba(34, 34, 34, 0.05);
  background-image: linear-gradient(rgba(0, 174, 239, var(--a)), rgba(0, 174, 239, var(--a)));
}
.heat-cell:hover { outline: 1.5px solid var(--pn-ink); }
.heat-scale {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-top: 0.75rem;
  font-family: var(--font-readout);
  font-size: 0.66rem;
  color: var(--pn-label);
}
.heat-scale i { width: 12px; }
</style>
