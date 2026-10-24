<script setup lang="ts">
import { Amphora, Anchor, Bot, CircuitBoard, CookingPot, Cuboid, Guitar, Hammer, Palette, Spool, Sprout, Telescope, ToyBrick, Wrench } from '@lucide/vue'

/**
 * Where are the makers: a walk down the faire's aisle. The section pins for
 * as long as it takes to scroll the row of stalls past, one discipline per
 * stall, under a striped awning. Without JavaScript, under reduced motion
 * (sideways scroll-jacking is a vestibular trigger), when the row already fits,
 * or when a stall is taller than the screen leaves room for (a landscape phone,
 * 200% zoom), it is a plain row that scrolls sideways on its own. A phone
 * never pins it: the words come first and the stalls are a row swiped
 * sideways, one stall at a time, with the same meter under it (a pinned
 * aisle cost a phone about nine screens of scrolling).
 *
 * The disciplines are deliberately not a tech list: roughly half are
 * non-technical, interleaved so no cluster reads as the "real" category.
 * Stalls drawn live further down the page link to their drawing.
 */
const domains = [
  { name: 'Robotics & AI', line: 'Walking, rolling and balancing machines, and the code that steers them.', icon: Bot, href: '#top', up: true },
  { name: 'Textiles & Weaving', line: 'Looms, handloom, embroidery and clothes that light up.', icon: Spool },
  { name: 'Electronics & IoT', line: 'Boards, sensors and soldering irons: things that blink, beep and talk.', icon: CircuitBoard, href: '#bench' },
  { name: 'Cooking & Fermenting', line: 'Kitchen science: pickles, ferments and food made by experiment.', icon: CookingPot },
  { name: '3D Printing', line: 'Printers, prints and the people who tune them.', icon: Cuboid },
  { name: 'Woodwork & Joinery', line: 'Saws, planes and chisels: furniture, toys and tools.', icon: Hammer, href: '#workshop' },
  { name: 'Repair & Restoration', line: 'Fixing instead of replacing: radios, bicycles, clocks.', icon: Wrench },
  { name: 'Pottery & Clay', line: 'Wheels, kilns and hand-built forms.', icon: Amphora },
  { name: 'Boats, Nets & Rope', line: 'The craft of the backwaters: nets, knots, hulls and rigging.', icon: Anchor, href: '#kochi', up: true },
  { name: 'Music & Instruments', line: 'Instruments built, hacked and played; synths and noise machines.', icon: Guitar, href: '#noise' },
  { name: 'Green Tech & Farming', line: 'Solar, compost, water and growing things.', icon: Sprout },
  { name: 'Toys, Kites & Games', line: 'Things made to play with, from kites to board games.', icon: ToyBrick, href: '#kochi', up: true },
  { name: 'Art & Illustration', line: 'Drawing, printmaking, murals and machines that draw.', icon: Palette, href: '#noise' },
  { name: 'Science & Space', line: 'Telescopes, rockets, weather stations and backyard experiments.', icon: Telescope },
]

const TONES = ['yellow', 'blue', 'paper', 'ink'] as const

const { state: motion } = useMotion()
const aisle = ref<HTMLElement | null>(null)
const track = ref<HTMLElement | null>(null)
const row = ref<HTMLElement | null>(null)
const pinned = ref(false)
const phone = ref(false)
const height = ref<string | undefined>(undefined)
const progress = ref(0)
/** The domain stall nearest the middle of the screen, for the meter. */
const at = ref(1)

let distance = 0
let raf = 0
/** Each stall's centre (px from the screen's left) with the row unmoved: measured per layout, not per scroll frame. */
let centres: number[] = []

function layout() {
  const el = track.value
  if (!el) return
  pinned.value = false
  height.value = undefined
  el.style.transform = ''
  // Measured unpinned: the row's own size against the screen (clientWidth: no scrollbar).
  const vw = document.documentElement.clientWidth
  distance = Math.max(0, el.scrollWidth - vw)
  centres = [...el.querySelectorAll<HTMLElement>('.stall')].map((s) => {
    const r = s.getBoundingClientRect()
    return r.left + r.width / 2
  })
  const rail = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-h')) || 58
  const fits = el.offsetHeight <= window.innerHeight - rail - 48
  pinned.value = distance > 0 && fits && motion.value !== 'reduced' && !phone.value
  height.value = pinned.value ? `${window.innerHeight + distance}px` : undefined
  update()
}

function update() {
  raf = 0
  const el = aisle.value
  const t = track.value
  if (!el || !t) return
  if (!pinned.value) {
    t.style.transform = ''
    return
  }
  const box = el.getBoundingClientRect()
  // Off screen: nothing to move (this runs on every scroll of the page).
  if (box.bottom < 0 || box.top > window.innerHeight) return
  const top = box.top
  const p = Math.min(1, Math.max(0, -top / Math.max(1, distance)))
  progress.value = p
  const shift = p * distance
  t.style.transform = `translate3d(${(-shift).toFixed(1)}px, 0, 0)`
  // From the cached centres, not fresh rects: reading layout right after writing the transform
  // forced a synchronous layout on every scroll frame while the aisle was pinned.
  const mid = document.documentElement.clientWidth / 2
  let best = 1
  let bestD = Infinity
  centres.forEach((c, i) => {
    const d = Math.abs(c - shift - mid)
    if (d < bestD) {
      bestD = d
      best = i + 1
    }
  })
  at.value = best
}

function onScroll() {
  if (!raf) raf = requestAnimationFrame(update)
}

/** Phones: the meter follows the swiped row. */
function onRowScroll() {
  const r = row.value
  const first = r?.querySelector<HTMLElement>('.stall')
  if (!r || !first) return
  const pitch = first.offsetWidth + (Number.parseFloat(getComputedStyle(r).columnGap) || 0)
  at.value = Math.min(domains.length, Math.round(r.scrollLeft / Math.max(1, pitch)) + 1)
  progress.value = Math.min(1, Math.max(0, r.scrollLeft / Math.max(1, r.scrollWidth - r.clientWidth)))
}

let mq: MediaQueryList | null = null
const onMq = () => {
  phone.value = Boolean(mq?.matches)
  layout()
}

/** A keyboard visitor tabbing to a stall's link: scroll the page so that stall is on screen. */
function onFocus(e: FocusEvent) {
  if (!pinned.value) return
  const s = (e.target as Element).closest<HTMLElement>('.stall')
  const el = aisle.value
  if (!s || !el) return
  // The browser's own focus scrolling may have moved the clipped row; undo it.
  const sticky = track.value?.parentElement
  if (sticky) sticky.scrollLeft = 0
  const x = s.offsetLeft + s.offsetWidth / 2 - document.documentElement.clientWidth / 2
  const p = Math.min(1, Math.max(0, x / Math.max(1, distance)))
  window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top + p * distance, behavior: 'instant' as ScrollBehavior })
}

onMounted(() => {
  mq = window.matchMedia('(max-width: 740px), (max-height: 500px) and (pointer: coarse)')
  mq.addEventListener('change', onMq)
  phone.value = mq.matches
  layout()
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', layout, { passive: true })
  // The display face arriving late changes every stall's size.
  document.fonts?.addEventListener('loadingdone', layout)
  document.fonts?.ready.then(layout)
})

watch(motion, layout)

onUnmounted(() => {
  mq?.removeEventListener('change', onMq)
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', layout)
  document.fonts?.removeEventListener('loadingdone', layout)
  cancelAnimationFrame(raf)
})
</script>

<template>
  <section id="categories" class="field field-paper aisle-field" aria-labelledby="categories-title">
    <div ref="aisle" class="aisle" :class="{ 'is-pinned': pinned }" :style="{ height }">
      <div class="aisle-sticky">
        <div ref="track" class="aisle-track" @focusin="onFocus">
          <div class="aisle-intro">
            <h2 id="categories-title" class="display-2">Where are the makers?</h2>
            <p class="lede aisle-lede">
              In Fab Labs, tinkering labs, campus chapters, startups and home
              workshops. Makers work across every discipline, from electronics and
              robotics to textiles, food and craft.
            </p>
            <p class="copy aisle-note">
              Technology is one part of making. Projects in wood, thread, clay, coir
              and food are equally welcome.
            </p>
          </div>

          <!-- A set of disciplines, not a menu: only the stalls drawn on this page link anywhere. -->
          <ol ref="row" class="stalls" aria-label="Domains" @scroll.passive="onRowScroll">
            <li v-for="(s, i) in domains" :key="s.name" class="stall" :class="`tone-${TONES[i % TONES.length]}`">
              <div class="awning" aria-hidden="true" />
              <div class="stall-board">
                <span class="stall-n" aria-hidden="true">{{ String(i + 1).padStart(2, '0') }}</span>
                <component :is="s.icon" class="stall-icon" :size="96" :stroke-width="1.5" aria-hidden="true" />
                <h3 class="stall-name">{{ s.name }}</h3>
                <p class="stall-line">{{ s.line }}</p>
                <!-- The word and arrow follow page order: the hero and the backwater are above the aisle. -->
                <a v-if="s.href" :href="s.href" class="stall-link" :class="{ 'is-up': s.up }">See it drawn {{ s.up ? 'above' : 'below' }}</a>
              </div>
            </li>
          </ol>
        </div>

        <div v-if="pinned || phone" class="aisle-meter" aria-hidden="true">
          <span class="meter-count">Domain {{ String(at).padStart(2, '0') }} / {{ domains.length }}</span>
          <span class="meter-track"><span class="meter-fill" :style="{ transform: `scaleX(${progress})` }" /></span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.aisle-field {
  padding: 0;
}

.aisle-sticky {
  overflow-x: auto;
  padding: clamp(4rem, 9vw, 7rem) 0;
}

.aisle.is-pinned .aisle-sticky {
  position: sticky;
  top: 0;
  height: 100vh;
  height: 100svh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  /* clip, not hidden: hidden is a scroll container the browser scrolls on focus. */
  overflow: clip;
  padding: 0 0 calc(var(--rail-h) + 2rem);
}

.aisle-track {
  display: flex;
  align-items: stretch;
  gap: clamp(1.25rem, 2.5vw, 2.5rem);
  width: max-content;
  padding-inline: max(1.25rem, (100vw - 82.5rem) / 2);
  will-change: transform;
}

.aisle-intro {
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: min(34rem, 84vw);
  padding-right: clamp(1rem, 4vw, 4rem);
}

.aisle-lede {
  margin-top: 1.5rem;
  color: var(--field-blue);
}

.aisle-note {
  margin-top: 1rem;
}

.stalls {
  display: flex;
  gap: clamp(1.25rem, 2.5vw, 2.5rem);
  margin: 0;
  padding: 0;
  list-style: none;
}

/* One stall: a striped awning with a scalloped valance over a sign board. */
.stall {
  --a1: var(--field-blue);
  --a2: var(--pn-enamel);
  --ground: var(--field-yellow);
  --ink: var(--pn-ink);
  --accent: var(--field-blue);
  display: flex;
  flex-direction: column;
  width: clamp(16.5rem, 24vw, 21rem);
  min-height: min(58svh, 33rem);
}

.tone-blue {
  --a1: var(--field-yellow);
  --a2: var(--field-blue);
  --ground: var(--field-blue);
  --ink: var(--on-blue);
  --accent: var(--field-yellow);
}

.tone-paper {
  --a1: var(--color-cyan);
  --a2: var(--pn-enamel);
  --ground: #fff;
  --accent: var(--field-blue);
}

.tone-ink {
  --a1: var(--field-yellow);
  --a2: var(--color-ink);
  --ground: var(--color-ink);
  --ink: var(--on-blue);
  --accent: var(--field-yellow);
}

.awning {
  flex: none;
  height: 4.25rem;
  background:
    radial-gradient(circle at 25% 0, var(--a1) 1.25rem, transparent calc(1.25rem + 0.5px)) 0 3rem / 5rem 1.25rem repeat-x,
    radial-gradient(circle at 75% 0, var(--a2) 1.25rem, transparent calc(1.25rem + 0.5px)) 0 3rem / 5rem 1.25rem repeat-x,
    repeating-linear-gradient(90deg, var(--a1) 0 2.5rem, var(--a2) 2.5rem 5rem) 0 0 / 100% 3rem no-repeat;
}

.stall-board {
  container-type: inline-size;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  margin-top: 0.75rem;
  padding: 1.5rem 1.5rem 1.75rem;
  background: var(--ground);
  color: var(--ink);
}

.tone-paper .stall-board {
  outline: 2px solid var(--pn-ink);
  outline-offset: -2px;
}

.stall-n {
  font-family: var(--font-readout);
  font-weight: 600;
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
}

.stall-icon {
  margin-top: 0.5rem;
  color: var(--accent);
}

.stall-name {
  margin: auto 0 0;
  font-family: var(--font-panel);
  font-weight: 400;
  /* Sized to the board: "RESTORATION" (about 10.5em) must fit its width. */
  font-size: min(1.85rem, 9.2cqi);
  line-height: 1.12;
  text-transform: uppercase;
  text-wrap: balance;
}

.stall-line {
  margin: 0;
  font-family: var(--font-readout);
  font-size: 1rem;
  line-height: 1.55;
}

.stall-link {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  font-family: var(--font-readout);
  font-weight: 600;
  font-size: 0.9375rem;
  color: inherit;
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 0.25em;
}

/* The page's ink ring vanishes on blue and ink stalls. */
.tone-blue .stall-link:focus-visible,
.tone-ink .stall-link:focus-visible {
  outline-color: var(--field-yellow);
}

.stall-link.is-up::after {
  content: '\2191';
}

.stall-link::after {
  content: '\2193';
  margin-left: 0.4em;
}

/* Where along the aisle: clear of the floating nav. */
.aisle-meter {
  position: absolute;
  left: max(1.25rem, (100vw - 82.5rem) / 2);
  right: max(1.25rem, (100vw - 82.5rem) / 2);
  bottom: calc(var(--rail-h) + 1.5rem);
  display: flex;
  align-items: center;
  gap: 1rem;
  font-family: var(--font-readout);
  font-weight: 600;
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-variant-numeric: tabular-nums;
}

.meter-track {
  position: relative;
  flex: 1 1 auto;
  height: 2px;
  background: var(--pn-faint);
}

.meter-fill {
  position: absolute;
  inset: 0;
  background: var(--field-blue);
  transform-origin: 0 50%;
}

/* Phones: the words, then the stalls as a row swiped one at a time, then the meter. */
@media (max-width: 740px), (max-height: 500px) and (pointer: coarse) {
  .aisle-sticky {
    overflow: visible;
    padding: 3.5rem 0;
  }

  .aisle-track {
    display: block;
    width: auto;
    padding: 0;
    will-change: auto;
  }

  .aisle-intro {
    width: auto;
    padding: 0 1.25rem;
  }

  .stalls {
    gap: 1rem;
    margin-top: 2rem;
    padding: 0 1.25rem 6px;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scroll-padding-inline: 1.25rem;
    scrollbar-width: none;
  }

  .stall {
    flex: none;
    width: min(78vw, 20rem);
    min-height: 0;
    scroll-snap-align: start;
  }

  .stall-board {
    gap: 0.7rem;
    padding: 1.25rem 1.25rem 1.5rem;
  }

  .stall-icon {
    width: 64px;
    height: 64px;
    margin-top: 0;
  }

  .aisle-meter {
    position: static;
    margin: 1.25rem 1.25rem 0;
  }
}
</style>
