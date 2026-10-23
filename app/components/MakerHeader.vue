<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Pause, Play, Volume2, VolumeX } from '@lucide/vue'
import { usePanelSound } from '~/composables/usePanelSound'

/**
 * Pinned title strip — the site's only navigation. It docks along the bottom
 * of the viewport on the page's own grid and names the sheet being read.
 *
 * Replaces the old sticky bordered top bar *and* its hamburger drawer. A bottom
 * bar is the correct primary-nav pattern on phones, so one component now serves
 * every breakpoint and the drawer is gone entirely.
 *
 * Ordering note: this component is mounted FIRST in app.vue, before <main>.
 * Visual bottom placement is CSS-only. A permanently visible primary nav that a
 * keyboard user can only reach after tabbing the whole page is a real failure,
 * and it outweighs the mild visual/DOM order mismatch.
 *
 * `links` is the seam: adding the remaining sections later is a push here, not
 * a markup edit.
 *
 * KEYBOARD AVOIDANCE WAS REMOVED, and it must come back with any future form.
 * This rail used to hide itself on phones whenever an <input> was focused and
 * `visualViewport` shrank, because the on-screen keyboard pins a fixed bottom
 * rail directly over the field being typed in. The only field on the site was
 * the footer newsletter, which is gone, so the code was unreachable.
 *
 * If you add ANY input, textarea or contenteditable to this page, restore it --
 * and key it off `visualViewport`, NOT focusin/focusout. Focus tracking looks
 * simpler and is broken: removing a focused element (a v-if on submit, say)
 * does not reliably fire focusout, so the rail stays hidden forever, taking the
 * site's only navigation with it. visualViewport measures the keyboard itself
 * and self-heals. Guard it with an activeElement check so a pinch zoom, which
 * also shrinks the visual viewport, does not hide the nav.
 */
/**
 * Order MUST match the page order. This is not cosmetic: recompute() below
 * walks this array and keeps OVERWRITING `current`, so the last link whose
 * section has crossed the 40% line wins. With the old order (countdown first)
 * the countdown moving to the bottom of the page would leave "Domains"
 * highlighted while the reader was actually in the countdown.
 */
const links = [
  { id: 'top', href: '#top', label: 'The event', n: '00' },
  { id: 'about', href: '#about', label: 'What is Maker Faire?', n: '01' },
  { id: 'kochi', href: '#kochi', label: 'Why Kochi, why now', n: '02' },
  { id: 'categories', href: '#categories', label: 'Where are the makers?', n: '03' },
  { id: 'workshop', href: '#workshop', label: 'Woodwork & joinery', n: '04' },
  { id: 'bench', href: '#bench', label: 'Electronics & IoT', n: '05' },
  { id: 'noise', href: '#noise', label: 'Make some noise', n: '06' },
  { id: 'take-part', href: '#take-part', label: 'Three ways in', n: '07' },
  { id: 'countdown', href: '#countdown', label: 'When', n: '08' },
  { id: 'beyond', href: '#beyond', label: '2027 and beyond', n: '09' },
]

const activeId = ref<string>('top')
const activeIndex = computed(() => Math.max(0, links.findIndex(l => l.id === activeId.value)))

const { enabled: soundOn, toggle: toggleSound } = usePanelSound()

/**
 * The page's one motion switch (WCAG 2.2.2): stops the 3D stage and every
 * other decorative animation, and is remembered. Hidden only when the OS has
 * already turned motion off, because then there is nothing for it to stop.
 */
const { view: motion, toggle: toggleMotion } = useMotion()
const paused = computed(() => motion.value === 'paused')

/**
 * Active-section tracking.
 *
 * Deliberately NOT an IntersectionObserver. The obvious rootMargin trick for a
 * "line at 40% of the viewport" — '-40% 0px -60% 0px' — is broken: per spec,
 * rootMargin percentages resolve against the root's WIDTH, not its height. On a
 * 1920x1080 viewport that is -768px/-1152px applied to a 1080px-tall root, i.e.
 * a negative-height rectangle that never fires. Making IO correct would mean
 * pixel margins recomputed from innerHeight plus tearing down and rebuilding the
 * observer on every resize.
 *
 * A rAF-throttled passive scroll listener reading fresh rects is fewer lines and
 * handles resize for free.
 */
function recompute() {
  const line = window.innerHeight * 0.4
  let current = 'top'
  for (const l of links) {
    const el = document.getElementById(l.id)
    if (el && el.getBoundingClientRect().top <= line) current = l.id
  }
  activeId.value = current
}

let ticking = false
function onScroll() {
  if (ticking) return
  ticking = true
  requestAnimationFrame(() => {
    recompute()
    ticking = false
  })
}

onMounted(() => {
  recompute()
  window.addEventListener('scroll', onScroll, { passive: true })
  // Reuses the rAF throttle: innerHeight feeds recompute(), so orientation
  // changes, resizes and zoom would otherwise strand aria-current on the wrong
  // section until the next scroll.
  window.addEventListener('resize', onScroll, { passive: true })
})

onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', onScroll)
})
</script>

<template>
  <div class="rail-wrap">
    <nav id="primary-nav" class="rail" aria-label="Primary">
      <!-- The route in miniature: the same stations as the page, in the same
           order, the current one inked. Names show on hover and focus. -->
      <ol class="rail-route">
        <li
          v-for="(l, i) in links"
          :key="l.id"
          class="rail-stop"
          :class="{ 'is-past': i < activeIndex, 'is-lit': i === activeIndex }"
        >
          <a
            :href="l.href"
            class="rail-stn"
            data-key-sound
            :aria-current="i === activeIndex ? 'location' : undefined"
          >
            <span class="rail-n" aria-hidden="true">{{ l.n }}</span>
            <span class="rail-name">{{ l.label }}</span>
          </a>
        </li>
      </ol>

      <a href="/interestform" class="key key-red rail-cta">Get Involved</a>

      <button
        v-if="motion !== 'reduced'"
        type="button"
        class="rail-icon"
        data-key-sound
        :aria-pressed="paused"
        aria-label="Pause motion"
        :title="paused ? 'Play motion' : 'Pause motion'"
        @click="toggleMotion"
      >
        <Play v-if="paused" :size="16" :stroke-width="1.75" aria-hidden="true" />
        <Pause v-else :size="16" :stroke-width="1.75" aria-hidden="true" />
      </button>

      <button
        type="button"
        class="rail-icon"
        data-key-sound
        role="switch"
        :aria-checked="soundOn"
        aria-label="Sound"
        :title="soundOn ? 'Sound on' : 'Sound off'"
        @click="toggleSound"
      >
        <Volume2 v-if="soundOn" :size="16" :stroke-width="1.75" aria-hidden="true" />
        <VolumeX v-else :size="16" :stroke-width="1.75" aria-hidden="true" />
        <!-- Visible state where the strip has room; the switch's name stays "Sound". -->
        <span class="rail-icon-text" aria-hidden="true">{{ soundOn ? 'Sound on' : 'Sound off' }}</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
/* A small floating strip in the drawing's own language: paper, one ink
   hairline, a soft drop. It replaced a full-width 58px bar. */
.rail-wrap {
  position: fixed;
  left: 50%;
  bottom: calc(12px + env(safe-area-inset-bottom));
  z-index: 120;
  transform: translateX(-50%);
  max-width: calc(100vw - 16px);
}

/* Big screens: the rail is px-built, so it steps up with the page's rem
   scale (main.css); --rail-h steps with it there. */
@media (min-width: 2400px) {
  .rail-wrap { zoom: 1.25; }
}

@media (min-width: 2880px) {
  .rail-wrap { zoom: 1.5; }
}

@media (min-width: 3600px) {
  .rail-wrap { zoom: 2; }
}

.rail {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 44px;
  padding: 0 0.375rem 0 0.75rem;
  background-color: var(--pn-enamel);
  border: 1px solid var(--pn-ink);
  box-shadow: 0 1px 2px rgba(34, 34, 34, 0.06), 0 10px 28px rgba(34, 34, 34, 0.12);
}

/* ── The route ── */
.rail-route {
  display: flex;
  align-items: center;
  margin: 0 0.25rem 0 0;
  padding: 0;
  list-style: none;
}

.rail-stop {
  position: relative;
  display: flex;
  align-items: center;
}

/* The hairline from the previous stop: inked once passed, dashed ahead. */
.rail-stop + .rail-stop::before {
  content: '';
  width: 10px;
  height: 0;
  border-top: 1px dashed var(--pn-faint);
}

.rail-stop.is-past + .rail-stop::before {
  border-top: 1px solid var(--pn-ink);
}

/* A 26x36 hit area around a 22px balloon (WCAG 2.5.8 asks 24px). */
.rail-stn {
  position: relative;
  display: grid;
  place-items: center;
  width: 26px;
  height: 36px;
  color: var(--pn-ink);
  text-decoration: none;
}

.rail-n {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1.5px solid var(--field-blue);
  border-radius: 50%;
  background: var(--pn-enamel);
  color: var(--field-blue);
  font: 700 9.5px/1 var(--font-readout);
  letter-spacing: 0;
  transition: background-color 200ms var(--ease-out), color 200ms var(--ease-out);
}

.is-past .rail-n {
  background: var(--field-blue);
  color: var(--pn-enamel);
}

.is-lit .rail-n {
  border-color: var(--field-blue);
  background: var(--field-yellow);
  color: var(--field-blue);
  box-shadow: 0 0 0 2px var(--field-blue);
}

/* The station's name: a small boxed label above it on hover/focus. It stays
   in the accessibility tree (opacity, not display) so it is the link's name. */
.rail-name {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  padding: 3px 7px;
  background: var(--pn-enamel);
  border: 1px solid var(--pn-ink);
  font: 500 11px/1.4 var(--font-readout);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  opacity: 0;
  transform: translate(-50%, 4px);
  pointer-events: none;
  transition: opacity 140ms var(--ease-out), transform 140ms var(--ease-out);
}

.rail-stn:hover .rail-name,
.rail-stn:focus-visible .rail-name {
  opacity: 1;
  transform: translate(-50%, 0);
}

.rail-stn:hover .rail-n {
  border-color: var(--pn-ink);
}

/* ── Keys ── */
.rail-cta {
  min-height: 32px;
  padding: 0.45rem 0.85rem 0.35rem;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.rail-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  background: transparent;
  color: var(--pn-ink);
  cursor: pointer;
}

.rail-icon:hover {
  border-color: var(--pn-ink);
}

.rail-icon[aria-pressed='true'],
.rail-icon[aria-checked='false'] {
  color: var(--pn-label);
}

/* The sound switch spells its state out, beside its icon, where the strip has room. */
.rail-icon[role='switch'] {
  display: inline-flex;
  gap: 0.4rem;
  width: auto;
  min-width: 32px;
  padding: 0 0.45rem;
}

.rail-icon-text {
  font: 600 11px/1 var(--font-readout);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}

@media (max-width: 900px) {
  .rail-icon-text {
    display: none;
  }

  .rail-icon[role='switch'] {
    width: 32px;
    padding: 0;
  }
}

/* A phone: the stations are the flexible part. They lose their connectors
   and, on the narrowest screens, scroll sideways inside the strip, so the
   Get Involved key and both toggles are always whole. */
@media (max-width: 480px) {
  .rail-wrap {
    left: 8px;
    right: 8px;
    transform: none;
    max-width: none;
  }

  .rail {
    gap: 0.25rem;
    padding: 0 0.25rem 0 0.375rem;
  }

  .rail-route {
    flex: 1 1 auto;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .rail-route::-webkit-scrollbar {
    display: none;
  }

  .rail-stop + .rail-stop::before {
    display: none;
  }

  /* No hover tooltips on touch; the name stays as the link's accessible name. */
  .rail-name {
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    border: 0;
  }

  .rail-stn {
    width: 24px;
  }

  .rail-n {
    width: 20px;
    height: 20px;
    font-size: 9px;
  }

  .rail-cta {
    padding: 0.45rem 0.55rem 0.35rem;
    font-size: 0.6875rem;
    letter-spacing: 0.03em;
  }

  .rail-icon,
  .rail-icon[role='switch'] {
    width: 28px;
    min-width: 0;
  }
}
</style>
