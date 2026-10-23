<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  title: string
  subtitle?: string
}>()

/**
 * Section titles carry their own order ("1. Basic information"). The number
 * is set apart as the section's big blue figure, and stays in the heading as
 * visually hidden text, so the heading's accessible name is the title exactly
 * as written.
 */
const parts = computed(() => {
  const m = /^(\d+)\.\s+(.*)$/.exec(props.title)
  return m ? { n: m[1]!, rest: m[2]! } : null
})
</script>

<template>
  <section class="at-section">
    <header class="at-section-head">
      <span v-if="parts" class="at-num" aria-hidden="true">{{ parts.n.padStart(2, '0') }}</span>
      <h2 class="at-section-title">
        <template v-if="parts"><span class="visually-hidden">{{ parts.n }}. </span>{{ parts.rest }}</template>
        <template v-else>{{ title }}</template>
      </h2>
      <p v-if="subtitle" class="at-section-sub">{{ subtitle }}</p>
    </header>
    <div class="at-section-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
/* One rule per section; the head beside its fields on wide screens (and
   pinned while they scroll past), above them on narrow ones. --at-cols,
   --at-gap and --field-w come from .at-shell (form-sheet.css). */
.at-section {
  display: grid;
  grid-template-columns: var(--at-cols);
  column-gap: var(--at-gap);
  padding: 3rem 0 3.5rem;
  border-top: 2px solid var(--pn-ink);
}

/* Of type: the form's first child is its honeypot div. */
.at-section:first-of-type {
  border-top: 0;
}

.at-section-head {
  container-type: inline-size;
  align-self: start;
  position: sticky;
  top: calc(64px + 2rem);
}

.at-num {
  display: block;
  margin-bottom: 0.75rem;
  font-family: var(--font-panel);
  font-size: clamp(2.5rem, 4vw, 3.5rem);
  line-height: 1;
  color: var(--field-blue);
}

.at-section-title {
  margin: 0;
  font-family: var(--font-panel);
  /* Sized to the head: "ORGANIZATION" (about 10.4em) must fit it. */
  font-size: min(var(--pn-d3), 9cqi);
  font-weight: 400;
  line-height: var(--lh-display);
  text-transform: uppercase;
  text-wrap: balance;
  color: var(--pn-ink);
}

.at-section-sub {
  margin: 0.75rem 0 0;
  font-size: 1rem;
  line-height: 1.5;
  color: var(--pn-label);
}

.at-section-body {
  min-width: 0;
}

@media (max-width: 900px), (max-height: 520px) {
  .at-section {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 2rem;
    padding: 2.5rem 0 3rem;
  }

  .at-section-head {
    position: static;
  }

  .at-section-title {
    font-size: min(var(--pn-d3), 8cqi);
  }
}
</style>
