<script setup lang="ts">
/**
 * The top bar of the inner sheets (forms, admin): one ink hairline under a
 * strip of paper, the real Maker Faire Kochi lockup on the left (its own
 * plaque and frame, never retypeset), the sheet's name, and the page links.
 * The current link carries a cyan bar -- cyan as "selected". It is a state
 * indicator, so it uses the 3:1-safe cyan (--color-cyan-text), not #00AEEF.
 */
defineProps<{
  sheet: string
  links: { href: string, label: string }[]
}>()
</script>

<template>
  <header class="sheet-bar">
    <a href="/" class="sheet-brand">
      <picture>
        <source srcset="/img/logo/mf-kochi-long@2x.webp 2x, /img/logo/mf-kochi-long.webp 1x" type="image/webp" />
        <img
          src="/img/logo/mf-kochi-long.png"
          width="193"
          height="32"
          class="sheet-logo"
          alt="Maker Faire Kochi"
          decoding="async"
        />
      </picture>
    </a>
    <span class="sheet-name">{{ sheet }}</span>
    <nav class="sheet-nav" :aria-label="sheet">
      <NuxtLink
        v-for="l in links"
        :key="l.href + l.label"
        :to="l.href"
        class="sheet-link"
        :class="{ 'is-home': l.href === '/' }"
      >{{ l.label }}</NuxtLink>
    </nav>
  </header>
</template>

<style scoped>
.sheet-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 1.5rem;
  height: var(--sheet-bar-h, 64px);
  padding: 0 var(--pn-gutter);
  background: var(--pn-enamel);
  border-bottom: 1px solid var(--pn-ink);
  font-family: var(--font-readout);
}

.sheet-brand {
  display: block;
  line-height: 0;
}

.sheet-logo {
  display: block;
  width: auto;
  height: 32px;
}

/* The sheet's name, set off from the lockup by a short hairline. */
.sheet-name {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  min-width: 0;
  font-size: 0.8125rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--pn-label);
}

.sheet-name::before {
  content: '';
  flex: none;
  width: 1px;
  height: 24px;
  background: var(--pn-ink);
}

.sheet-nav {
  display: flex;
  align-self: stretch;
  gap: 0.25rem;
}

.sheet-link {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 0 0.85rem;
  font-size: 0.8125rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--pn-ink);
}

/* The bar under a link sits on the header's own hairline. */
.sheet-link::after {
  content: '';
  position: absolute;
  left: 0.85rem;
  right: 0.85rem;
  bottom: -1px;
  height: 3px;
  background: transparent;
  transition: background-color 160ms var(--ease-out);
}

.sheet-link:hover::after {
  background: var(--pn-ink);
}

.sheet-link.router-link-exact-active::after {
  background: var(--color-cyan-text);
}

.sheet-link:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -6px;
  border-radius: 0;
}

@media (max-width: 900px) {
  .sheet-bar {
    padding: 0 1rem;
    column-gap: 1rem;
  }
}

@media (max-width: 640px) {
  .sheet-bar {
    --sheet-bar-h: 56px;
    grid-template-columns: auto minmax(0, 1fr);
  }

  .sheet-name {
    display: none;
  }

  .sheet-logo {
    height: 24px;
  }

  .sheet-nav {
    justify-self: end;
    gap: 0;
  }

  .sheet-link {
    padding: 0 0.5rem;
    font-size: 0.75rem;
    letter-spacing: 0.03em;
  }

  .sheet-link::after {
    left: 0.5rem;
    right: 0.5rem;
  }
}

/* A phone has no room for the logo and three links: the logo is already the
   way home. */
@media (max-width: 430px) {
  .sheet-link.is-home {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sheet-link::after {
    transition: none;
  }
}
</style>
