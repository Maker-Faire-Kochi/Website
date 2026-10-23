<script setup lang="ts">
import { EVENT } from '~/composables/useCountdown'
import HeroLeaders from '~/components/hero/HeroLeaders.vue'
import { heroKeepOut } from '~/three/core/signal'

/**
 * The opening poster. A yellow field, the campaign's blue headline, the
 * definition and the one red action on the left; the robots' playground
 * (app/three/scenes/hero.ts) fills the poster edge to edge, framed for the
 * space right of the words; a blue strip along the bottom carries the three facts a visitor
 * needs: when, where, what it costs.
 *
 * Text panels stay above the drawing (.field children are z-index 1) and the
 * robots' slot is transparent. Pointer input is taken from the whole hero so
 * the robots watch a cursor even over the words. Every pointer interaction has
 * a button below the stage (WCAG 2.1.1), announced in a polite live region.
 */
const [endDay, ...endRest] = EVENT.rangeEnd.label.split(' ')
const endMonth = endRest.join(' ')

/** Key to the drawing: the cast, then what the two signal colours mean. */
const parts: { n?: string, swatch?: string, label: string }[] = [
  { n: '01', label: 'Makey' },
  { n: '02', label: 'Duck walker' },
  { n: '03', label: 'Wheel-legged balancer' },
  { n: '04', label: 'Robot dog' },
  { swatch: 'red', label: 'Drive · motors & wheels' },
  { swatch: 'cyan', label: 'Selected robot' },
]

const controls = [
  { action: 'next', label: 'Next robot' },
  { action: 'nudge', label: 'Nudge' },
  { action: 'call', label: 'Call over' },
  { action: 'shoo', label: 'Shoo' },
  { action: 'look', label: 'Look here' },
  { action: 'crash', label: 'Crash' },
]

/**
 * The robots roam the WHOLE first screen. The words block and the key box are
 * published as keep-out rects (heroKeepOut, fractions of the slot): the scene
 * turns them into walls on the floor, so the robots walk around the text and
 * never under it. Below 900px wide or 600px tall the playground stacks under
 * the words and has the key below it, so nothing is kept out.
 *
 * Re-measured whenever anything that moves the text can change (resize, the
 * stacking query, every font load, the blocks' own size), at most once a
 * frame, and `version` only moves when a rect really moved: each bump makes
 * the scene rebuild its walls and pitch.
 */
const STACKED = '(max-width: 900px), (max-height: 600px)'
type Rect = { x0: number, x1: number, y0: number, y1: number }
const phone = ref(false)
const copy = ref<HTMLElement | null>(null)
const under = ref<HTMLElement | null>(null)
let mq: MediaQueryList | null = null
let ro: ResizeObserver | null = null
let measureRaf = 0

function sameRects(a: Rect[], b: Rect[]) {
  return a.length === b.length && a.every((r, i) => {
    const o = b[i]!
    return Math.abs(r.x0 - o.x0) < 0.002 && Math.abs(r.x1 - o.x1) < 0.002 && Math.abs(r.y0 - o.y0) < 0.002 && Math.abs(r.y1 - o.y1) < 0.002
  })
}

function measureFocus() {
  measureRaf = 0
  phone.value = Boolean(mq?.matches)
  const slot = copy.value?.closest('.hero-main')?.querySelector<HTMLElement>('.hero-stage')
  const s = slot?.getBoundingClientRect()
  const rects: Rect[] = []
  // A fixed element (the nav rail) is placed as it sits over the hero at the
  // top of the page, whatever the current scroll.
  const add = (r: { left: number, right: number, top: number, bottom: number }, fixed = false) => {
    if (!s || r.right - r.left < 1 || r.bottom - r.top < 1) return
    const top = fixed ? s.top + window.scrollY : s.top
    rects.push({ x0: (r.left - s.left) / s.width, x1: (r.right - s.left) / s.width, y0: (r.top - top) / s.height, y1: (r.bottom - top) / s.height })
  }
  if (s && s.width > 0 && s.height > 0 && !phone.value && copy.value) {
    // The logo on its own, then the words as one block (title to the actions),
    // so the robots can still cross the gap between them.
    const [logo, ...words] = [...copy.value.children] as HTMLElement[]
    if (logo) add(logo.getBoundingClientRect())
    const b = words.map(w => w.getBoundingClientRect()).filter(r => r.width > 0)
    if (b.length) add({ left: Math.min(...b.map(r => r.left)), right: Math.max(...b.map(r => r.right)), top: Math.min(...b.map(r => r.top)), bottom: Math.max(...b.map(r => r.bottom)) })
    for (const el of [under.value, document.querySelector<HTMLElement>('.hero-hint')]) {
      if (el) add(el.getBoundingClientRect())
    }
    // The floating nav rail too, so no robot plays under it.
    const rail = document.querySelector<HTMLElement>('#primary-nav')
    if (rail) add(rail.getBoundingClientRect(), true)
  }
  if (sameRects(rects, heroKeepOut.rects)) return
  heroKeepOut.rects = rects
  heroKeepOut.version++
  // Dev only: the poster renderer reads the live layout's rects (scripts/render-poster.mjs).
  if (import.meta.dev) (window as any).__heroKeepOut = heroKeepOut
}

function scheduleMeasure() {
  if (!measureRaf) measureRaf = requestAnimationFrame(measureFocus)
}

onMounted(() => {
  mq = window.matchMedia(STACKED)
  measureFocus()
  mq.addEventListener('change', scheduleMeasure)
  window.addEventListener('resize', scheduleMeasure, { passive: true })
  // The web fonts arrive after first paint (non-blocking), and resize the words.
  document.fonts?.addEventListener('loadingdone', scheduleMeasure)
  document.fonts?.ready.then(scheduleMeasure)
  ro = new ResizeObserver(scheduleMeasure)
  for (const el of [copy.value, under.value]) if (el) ro.observe(el)
})
onUnmounted(() => {
  cancelAnimationFrame(measureRaf)
  mq?.removeEventListener('change', scheduleMeasure)
  window.removeEventListener('resize', scheduleMeasure)
  document.fonts?.removeEventListener('loadingdone', scheduleMeasure)
  ro?.disconnect()
})

/**
 * Save-Data, decided on the server where the header is readable and carried
 * across hydration by useState (a client recompute would see {} and lose it).
 * SceneSlot reads the same key, plus navigator.connection.saveData.
 */
useState('hero-save-data', () => useRequestHeaders(['save-data'])['save-data'] === 'on')

const { state: motion, view } = useMotion()
const stage = ref<{ action: (name: string) => string | null } | null>(null)
const status = ref('')
/** The live drawing will never run for this visitor (Save-Data, no WebGL): no controls, no hint. */
const unavailable = ref(false)

async function announce(text: string) {
  // Cleared first so the same status twice is announced twice.
  status.value = ''
  await nextTick()
  status.value = text
}

function run(action: string) {
  const out = stage.value?.action(action)
  announce(out ?? (motion.value === 'running' ? 'The robots are still waking up.' : 'Motion is paused. Press Play motion to run the robots.'))
}

/** Easter eggs (useEasterEggs): each runs as a hero scene action. */
const EGG_STATUS: Record<string, string> = {
  'dance': 'The robots are dancing.',
  'conga': 'Conga line!',
  'party': 'Party mode.',
  'line-up': 'The robots line up and take a bow.',
  'sleep': 'The robots have dozed off. Move the pointer to wake them.',
}
const { onLogoClick } = useEasterEggs((egg) => {
  const out = stage.value?.action(egg)
  if (out) announce(EGG_STATUS[egg] ?? out)
})
</script>

<template>
  <section id="top" class="hero field field-yellow" aria-labelledby="hero-title">
    <!-- The playground fills the poster edge to edge; the words hold the left
         and the robots' focus box the rest (data-focus, see fit() in stage.ts).
         On a phone the words come first and the playground follows. -->
    <div class="hero-main">
      <ThreeSceneSlot
        ref="stage"
        scene="hero"
        poster="/img/scenes/hero"
        poster-alt="Makey the Maker Faire robot, duck-style walking robots, a wheel-legged balancer and a robot dog, built from slotted beams, playing on a test mat."
        class="hero-stage"
        input-host=".hero"
        priority
        phone-media="(max-width: 900px), (max-height: 600px)"
        poster-position="73% 50%"
        @unavailable="unavailable = true"
      />
      <HeroLeaders />

      <div class="hero-grid">
        <div ref="copy" class="hero-copy" data-scene-ignore>
          <picture class="hero-logo" @click="onLogoClick">
            <source srcset="/img/logo/mf-kochi-long@2x.webp 2x, /img/logo/mf-kochi-long.webp 1x" type="image/webp" />
            <img
              src="/img/logo/mf-kochi-long.png"
              width="320"
              height="53"
              alt="Maker Faire Kochi"
              decoding="async"
            />
          </picture>

          <h1 id="hero-title" class="hero-title display">
            <BitsSplitText :lines="['Where are', 'the makers?']" :delay="1050" />
          </h1>
          <p class="hero-claim lede">Kerala’s first licensed Maker Faire.</p>

          <p class="copy hero-def">
            A festival of invention, creativity and hands-on learning: a show and
            tell where inventors, engineers, crafters, students and hobbyists show
            what they make, and how. Kochi, 5–6 February 2027.
          </p>

          <!-- The three facts a visitor needs, on the first screen. -->
          <dl class="hero-facts">
            <div class="fact">
              <dt class="label">When</dt>
              <dd>
                <time :datetime="EVENT.rangeStart.iso">{{ EVENT.rangeStart.label }}</time>&ndash;<time :datetime="EVENT.rangeEnd.iso">{{ endDay }} {{ endMonth }}</time>
              </dd>
            </div>
            <div class="fact">
              <dt class="label">Where</dt>
              <dd>
                <a :href="EVENT.venueMapUrl" target="_blank" rel="noopener noreferrer">{{ EVENT.venueLabel }}</a>, {{ EVENT.place }}
              </dd>
            </div>
            <div class="fact">
              <dt class="label">Admission</dt>
              <dd>{{ EVENT.admissionLabel }}</dd>
            </div>
          </dl>

          <div class="hero-actions">
            <a href="/interestform" class="key key-red">Get Involved</a>
            <a href="#about" class="key">Learn More</a>
          </div>
        </div>
      </div>

      <p v-if="view !== 'reduced' && !unavailable" class="hero-hint label" aria-hidden="true" data-scene-ignore>
        Move your pointer. Grab a robot and throw it.
      </p>

      <div ref="under" class="hero-under" data-scene-ignore>
        <ul class="hero-key" aria-label="Key to the drawing">
          <li v-for="p in parts" :key="p.label">
            <span v-if="p.n" class="key-n">{{ p.n }}</span>
            <span v-else class="key-swatch" :class="`is-${p.swatch}`" aria-hidden="true" />
            {{ p.label }}
          </li>
        </ul>
        <div v-if="view !== 'reduced' && !unavailable" class="hero-controls" role="group" aria-label="Robot controls">
          <button v-for="c in controls" :key="c.action" type="button" class="chip" @click="run(c.action)">{{ c.label }}</button>
        </div>
      </div>
      <p class="visually-hidden" aria-live="polite">{{ status }}</p>
    </div>

  </section>
</template>

<style scoped>
/* The playground is the whole first screen; the words float on its left. */
.hero {
  --hero-gutter: clamp(1.25rem, 4vw, 4rem);
  padding: 0;
}

.hero-main {
  height: 100vh;
  height: 100svh;
  min-height: 600px;
}

.hero-stage {
  position: absolute;
  inset: 0;
}

/* The page gutter, not the 1320px wrap: on a wide screen the words keep to the
   left edge and the robots get everything to their right. */
.hero-grid {
  height: 100%;
  display: flex;
  align-items: stretch;
  padding-inline: var(--hero-gutter);
  pointer-events: none;
}

/* No ground of its own: the robots treat the words as walls (heroKeepOut). */
.hero-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: safe center;
  width: min(42%, 38rem);
  /* Clear of the floating nav at the bottom. */
  padding: clamp(1.25rem, 2.5vw, 2rem) 0 calc(var(--rail-h) + 1.25rem);
  pointer-events: auto;
}

.hero-logo {
  display: block;
  margin-bottom: auto;
  cursor: default;
}

.hero-logo img {
  display: block;
  width: min(13.75rem, 60vw);
  height: auto;
}

/* "THE MAKERS?" is about 9.4em wide in Dela Gothic One: sized so it holds
   one line in the words column (42% of the screen, at most 38rem). */
.hero-title {
  margin-top: clamp(1rem, 4vh, 3rem);
  font-size: clamp(2.2rem, min(3.9vw, 8.5vh), 3.75rem);
}

.hero-claim {
  margin-top: 1rem;
  color: var(--pn-ink);
}

.hero-def {
  margin-top: 0.9rem;
  max-width: 48ch;
  font-size: 1rem;
  line-height: 1.6;
}

/* The facts: a ruled row of three, the values in the display face. */
.hero-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.9rem 1.75rem;
  margin: 1.4rem 0 0;
  padding-top: 1rem;
  border-top: 2px solid var(--field-blue);
}

.fact dt {
  color: var(--pn-label);
}

.fact dd {
  margin: 0.3rem 0 0;
  font-family: var(--font-panel);
  font-size: clamp(1rem, 1.35vw, 1.25rem);
  line-height: 1.2;
  color: var(--field-blue);
}

.fact a {
  color: inherit;
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 0.2em;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 1.5rem 0 auto;
}

.hero-hint {
  position: absolute;
  top: clamp(1.25rem, 2.5vw, 2rem);
  right: var(--hero-gutter);
  padding: 0.35rem 0;
  color: var(--field-blue);
}

/* Clear of the floating nav, which now sits over the playground's lower edge. */
.hero-under {
  position: absolute;
  right: var(--hero-gutter);
  bottom: calc(var(--rail-h) + 1.5rem);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.6rem;
  max-width: 54%;
  padding: 0.75rem 0.9rem;
}

.hero-key {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.4rem 1.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
  font-family: var(--font-readout);
  font-weight: 600;
  font-size: 0.8125rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.hero-key li {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.key-n {
  display: inline-grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border: 2px solid var(--field-blue);
  border-radius: 50%;
  font-size: 0.6875rem;
  letter-spacing: 0;
}

.key-swatch {
  width: 1.4rem;
  height: 0.45rem;
}

.key-swatch.is-red { background: var(--color-red); }
.key-swatch.is-cyan { background: var(--color-cyan); }

.hero-controls {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.4rem;
}

/* Phones, narrow tablets and short screens (a landscape phone, a laptop at
   200% zoom; 600px, where the key box would meet the nav rail): the words,
   then the playground edge to edge, then its key. */
@media (max-width: 900px), (max-height: 600px) {
  .hero {
    height: auto;
    min-height: 0;
  }

  .hero-main {
    display: flex;
    flex-direction: column;
    height: auto;
    min-height: 0;
  }

  .hero-grid {
    order: 1;
    height: auto;
  }

  .hero-copy {
    width: auto;
    padding: 1.25rem 0 1.5rem;
  }

  .hero-logo {
    margin-bottom: 0;
  }

  .hero-actions {
    margin-bottom: 0;
  }

  /* The words' parts become the column's own items, so the playground sits
     right under the headline and the three facts: a phone's first screen
     shows the robots, not only text. (Nothing is kept out when stacked, so
     the words block needs no box of its own.) */
  .hero-grid,
  .hero-copy {
    display: contents;
  }

  .hero-copy > * {
    margin-inline: var(--hero-gutter);
  }

  .hero-logo {
    order: 1;
    margin-top: 1.25rem;
  }

  .hero-title { order: 2; }
  .hero-claim { order: 3; }
  .hero-facts { order: 4; }

  .hero-def {
    order: 6;
    margin-top: 1rem;
  }

  .hero-actions {
    order: 7;
    margin-bottom: 0.5rem;
  }

  /* Sized to the mat, a landscape shape: a tall box only added empty field above and below it. */
  .hero-stage {
    order: 5;
    position: relative;
    inset: auto;
    height: min(68svh, 80vw);
    min-height: 260px;
    margin-top: 0.5rem;
  }

  .hero-hint {
    display: none;
  }

  .hero-under {
    order: 8;
    position: static;
    align-items: flex-start;
    max-width: none;
    padding: 0.75rem var(--hero-gutter) 1.5rem;
  }

  .hero-key,
  .hero-controls {
    justify-content: flex-start;
  }
}
</style>
