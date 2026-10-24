<script setup lang="ts">
import type { Ref } from 'vue'

/**
 * Longer copy that a phone folds behind a "Read more" toggle. Wide screens
 * always show it (the toggle is hidden), and so does a page without
 * JavaScript: it only folds once mounted, so no text is ever out of reach.
 * Inside a chapter it folds again when the chapter moves to another step, so
 * an open card never stays over the drawing.
 */
const open = ref(false)
const ready = ref(false)
const id = useId()
const step = inject<Ref<number> | null>('chapterStep', null)

if (step) watch(step, () => { open.value = false })
onMounted(() => { ready.value = true })
</script>

<template>
  <div class="read-more" :class="{ 'is-ready': ready, 'is-open': open }">
    <button type="button" class="read-more-toggle" :aria-expanded="open" :aria-controls="id" @click="open = !open">
      {{ open ? 'Show less' : 'Read more' }}
    </button>
    <div :id="id" class="read-more-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.read-more-toggle {
  display: none;
}

.read-more-body > :deep(* + *) {
  margin-top: 1.1rem;
}

@media (max-width: 740px), (max-height: 500px) and (pointer: coarse) {
  .read-more.is-ready .read-more-toggle {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0;
    font-family: var(--font-readout);
    font-weight: 600;
    font-size: 0.9375rem;
    color: inherit;
    background: none;
    border: 0;
    text-decoration: underline;
    text-decoration-thickness: 2px;
    text-underline-offset: 0.25em;
    cursor: pointer;
  }

  .read-more-toggle:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 3px;
  }

  .read-more.is-ready:not(.is-open) .read-more-body {
    display: none;
  }

  .read-more.is-open .read-more-body {
    margin-top: 0.25rem;
  }
}
</style>
