<script setup lang="ts">
/**
 * Split text (after React Bits' SplitText): each character rises into place
 * in sequence. CSS only, so it plays from the SSR HTML with no hydration
 * wait, and no-JS visitors get the same entrance. The real text is the
 * accessible name; the per-character spans are hidden from assistive tech.
 */
const props = withDefaults(defineProps<{
  lines: string[]
  /** Start of the first character, in ms. */
  delay?: number
  /** Gap between characters, in ms. */
  stagger?: number
}>(), { delay: 0, stagger: 26 })

const chars = computed(() => {
  let i = 0
  return props.lines.map(line => line.split(' ').map(word => [...word].map(ch => ({ ch, i: i++ }))))
})
</script>

<template>
  <span class="split">
    <span class="visually-hidden">{{ lines.join(' ') }}</span>
    <span v-for="(line, li) in chars" :key="li" class="split-line" aria-hidden="true">
      <template v-for="(word, wi) in line" :key="wi">
        <span class="split-word"><span
          v-for="c in word"
          :key="c.i"
          class="split-char"
          :style="{ animationDelay: `${delay + c.i * stagger}ms` }"
        >{{ c.ch }}</span></span>{{ wi < line.length - 1 ? ' ' : '' }}
      </template>
    </span>
  </span>
</template>

<style scoped>
.split-line {
  display: block;
}

.split-word {
  display: inline-block;
  white-space: nowrap;
}

.split-char {
  display: inline-block;
  animation: split-rise 640ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

@keyframes split-rise {
  from {
    opacity: 0;
    transform: translateY(0.55em) rotate(4deg);
    filter: blur(6px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .split-char {
    animation: none;
  }
}

/* A stored Pause (useMotion) skips the entrance too. Keyed to the state at
   LOAD (data-motion-start, set once), not the live one: pressing Play later
   would otherwise re-add the animation and blank the headline to replay it. */
:root[data-motion-start='paused'] .split-char {
  animation: none;
}
</style>
