<script setup lang="ts">
import type { NuxtError } from '#app'
import { CONTACT_EMAIL, EVENT } from '~/composables/useCountdown'

const props = defineProps<{ error: NuxtError }>()

const code = computed(() => props.error?.statusCode ?? 500)
const missing = computed(() => code.value === 404)
const codeLabel = computed(() => String(code.value).padStart(3, '0'))

useSeoMeta({
  title: () => (missing.value ? '404 — Page not found | Maker Faire Kochi' : `${code.value} — Maker Faire Kochi`),
  description: () =>
    missing.value
      ? "Page not found. No content here: we ran out of tokens, so we stopped. We'll ask a maker to complete this."
      : 'Something jammed while drawing this page.',
})

function go(path: string) {
  clearError({ redirect: path })
}
</script>

<template>
  <div class="err maker-app" :class="{ 'err-missing field-yellow': missing }">

    <main class="err-shell">
      <!-- No bar, as on the landing page: the real lockup, which is the way home. -->
      <a href="/" class="err-logo-link" @click.prevent="go('/')">
        <picture>
          <source srcset="/img/logo/mf-kochi-long@2x.webp 2x, /img/logo/mf-kochi-long.webp 1x" type="image/webp" />
          <img class="err-logo" src="/img/logo/mf-kochi-long.png" width="193" height="32" alt="Maker Faire Kochi" decoding="async" />
        </picture>
      </a>

      <header v-if="!missing" class="err-rule" aria-hidden="true">
        <span>Sht {{ codeLabel }} / ERR</span>
        <span>{{ missing ? 'Not in set' : 'Fault' }}</span>
        <span>Maker Faire Kochi · 2027</span>
      </header>

      <div class="err-grid">
        <div class="err-copy-col">
          <div class="err-title-box">
            <p v-if="missing" class="err-eyebrow">404 · Page not found</p>
            <h1 class="display err-title">
              <template v-if="missing">
                We ran out of tokens, so we stopped.
              </template>
              <template v-else>
                Plot <span class="err-accent">jammed</span>
              </template>
            </h1>
            <p v-if="missing" class="err-punch">We'll ask a maker to complete this.</p>
            <p v-if="missing" class="err-nothing">No content here. It was working yesterday, we swear.</p>
          </div>

          <p v-if="!missing" class="err-lede">
            {{ error.statusMessage || 'Something went wrong while drawing this page.' }}
          </p>

          <p v-if="!missing" class="err-note">
            The Faire is still on the bench. Go home, send interest, or join the media
            team.
          </p>

          <div class="err-actions">
            <button type="button" class="key key-red" @click="go('/')">
              Back to the drawing
            </button>
            <button type="button" class="key" @click="go('/interestform')">
              Get Involved
            </button>
            <button type="button" class="key" @click="go('/volunteer')">
              Media volunteer
            </button>
          </div>
        </div>

        <MakeyFacepalm v-if="missing" />
        <aside v-else class="err-card" aria-hidden="true">
          <div class="err-brand-bar"><span class="cyan" /><span class="red" /></div>

          <div class="err-stage">
            <svg class="err-fig" viewBox="0 0 360 300" role="img">
              <title>Missing figure</title>
              <defs>
                <pattern id="err-dots" width="16" height="16" patternUnits="userSpaceOnUse">
                  <circle cx="1" cy="1" r="1" fill="rgba(34,34,34,0.14)" />
                </pattern>
              </defs>
              <rect width="360" height="300" fill="#F6F6F3" />
              <rect width="360" height="300" fill="url(#err-dots)" />

              <!-- Registration ticks -->
              <g stroke="#00AEEF" stroke-width="1.5" fill="none">
                <path d="M18 18h14M18 18v14" />
                <path d="M342 18h-14M342 18v14" />
                <path d="M18 282h14M18 282v-14" />
                <path d="M342 282h-14M342 282v-14" />
              </g>

              <!-- Empty hit box -->
              <rect
                x="58"
                y="48"
                width="244"
                height="188"
                fill="rgba(0,174,239,0.05)"
                stroke="#00AEEF"
                stroke-width="1.5"
                stroke-dasharray="6 5"
              />

              <!-- Ghost bench machine -->
              <g
                fill="none"
                stroke="#222222"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                opacity="0.22"
              >
                <path d="M118 210H242" />
                <path d="M132 210V150h96v60" />
                <path d="M156 150V108h48v42" />
                <circle cx="180" cy="168" r="26" />
                <path d="M180 142v52M154 168h52" />
                <path d="M140 210v18h80v-18" />
                <path d="M168 108V88M192 108V88" />
              </g>

              <text
                x="180"
                y="178"
                text-anchor="middle"
                fill="#ED1C24"
                font-family="Anton, Arial Narrow, sans-serif"
                font-size="64"
                font-weight="400"
              >{{ code }}</text>

              <!-- Balloon callout -->
              <g transform="translate(268 62)">
                <path d="M0 18L-28 48" stroke="#00AEEF" stroke-width="1.25" fill="none" />
                <circle r="16" fill="#00AEEF" />
                <text
                  y="5"
                  text-anchor="middle"
                  fill="#FFFFFF"
                  font-family="IBM Plex Mono, monospace"
                  font-size="12"
                  font-weight="500"
                >—</text>
              </g>

              <text
                x="180"
                y="268"
                text-anchor="middle"
                fill="#006E9B"
                font-family="IBM Plex Mono, monospace"
                font-size="11"
                font-weight="500"
                letter-spacing="0.14em"
              >FIG. — · NOT IN SET</text>
            </svg>
          </div>

          <dl class="err-spec">
            <div>
              <dt>Status</dt>
              <dd>{{ code }}</dd>
            </div>
            <div>
              <dt>Sheet</dt>
              <dd>{{ missing ? 'Missing' : 'Fault' }}</dd>
            </div>
            <div>
              <dt>Event</dt>
              <dd>5–6 Feb</dd>
            </div>
          </dl>
        </aside>
      </div>

    </main>

    <!-- The landing page's yellow-then-blue rhythm: the event, as plain facts. -->
    <footer v-if="missing" class="err-event">
      <p class="err-event-name">Maker Faire Kochi</p>
      <p class="err-event-facts">
        {{ EVENT.rangeStart.label }}–{{ EVENT.rangeEnd.label }} · {{ EVENT.venueLabel }}, {{ EVENT.place }} · {{ EVENT.admissionLabel }}
      </p>
      <a class="err-event-mail" :href="`mailto:${CONTACT_EMAIL}`">{{ CONTACT_EMAIL }}</a>
    </footer>
  </div>
</template>

<style scoped>
.err {
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  color: var(--pn-ink);
  background-color: var(--pn-enamel);
  background-image: var(--pn-grain);
  background-size: 24px 24px;
  background-position: -12px -12px;
}









.err-shell {
  flex: 1;
  width: min(100%, 68rem);
  margin: 0 auto;
  padding: 2rem var(--pn-gutter) calc(var(--rail-h) + 2.5rem);
}

.err-rule {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 1rem;
  margin-bottom: 2.5rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--pn-ink);
  font-family: var(--font-readout);
  font-weight: 500;
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.err-rule::before,
.err-rule::after {
  content: '';
  position: absolute;
  top: -7px;
  width: 1px;
  height: 13px;
  background: var(--color-cyan);
}

.err-rule::before {
  left: 0;
}

.err-rule::after {
  left: 33.333%;
}

.err-rule span:nth-child(2) {
  color: var(--color-cyan-text);
  text-align: center;
}

.err-rule span:last-child {
  color: var(--pn-label);
  text-align: right;
}

.err-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(16rem, 0.95fr);
  gap: 2.5rem 3rem;
  align-items: center;
}

.err-title {
  font-size: clamp(3rem, 8vw, 4.75rem);
  color: var(--pn-ink);
}

.err-accent {
  color: var(--color-red);
}

.err-lede {
  margin: 1.25rem 0 0;
  max-width: 34ch;
  font-family: var(--font-readout);
  font-size: 1.125rem;
  line-height: 1.55;
  color: var(--pn-ink);
}

.err-note {
  margin: 1rem 0 0;
  max-width: 38ch;
  font-family: var(--font-readout);
  font-size: 1rem;
  line-height: 1.5;
  color: var(--pn-label);
}

.err-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1.75rem;
}

.err-card {
  background: var(--pn-enamel);
  border: 1px solid var(--pn-ink);
  box-shadow: 0 1px 2px rgba(34, 34, 34, 0.06), 0 12px 32px rgba(34, 34, 34, 0.08);
  overflow: hidden;
}

.err-brand-bar {
  display: flex;
  height: 4px;
}

.err-brand-bar .cyan {
  flex: 2;
  background: var(--color-cyan);
}

.err-brand-bar .red {
  flex: 1;
  background: var(--color-red-cta);
}

.err-stage {
  border-bottom: 1px solid var(--pn-ink);
}

.err-fig {
  display: block;
  width: 100%;
  height: auto;
}

.err-spec {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
}

.err-spec > div {
  padding: 0.85rem 1rem;
  box-shadow: -1px 0 0 var(--pn-ink);
}

.err-spec > div:first-child {
  box-shadow: none;
}

.err-spec dt {
  font-family: var(--font-readout);
  font-weight: 500;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-cyan-text);
}

.err-spec dd {
  margin: 0.3rem 0 0;
  font-family: var(--font-readout);
  font-weight: 500;
  font-size: 0.875rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

@media (max-width: 900px) {
  .err-grid {
    grid-template-columns: 1fr;
    gap: 2rem;
  }

  .err-card {
    max-width: 28rem;
  }

  .err-rule::after {
    display: none;
  }
}

@media (max-width: 640px) {
  .err-shell {
    padding: 1.5rem 1.25rem calc(var(--rail-h) + 1.75rem);
  }

  .err-rule {
    grid-template-columns: 1fr;
    gap: 0.35rem;
  }

  .err-rule span:nth-child(2),
  .err-rule span:last-child {
    text-align: left;
  }

  .err-spec {
    grid-template-columns: 1fr;
  }

  .err-spec > div {
    box-shadow: 0 -1px 0 var(--pn-ink);
  }

  .err-spec > div:first-child {
    box-shadow: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .err-actions :deep(.key) {
    transition: none;
  }
}

.err-missing { background-image: none; background-color: var(--field-yellow); }
.err-missing .err-shell { width: min(100%, 82.5rem); padding-bottom: 2.5rem; }
.err-missing .err-shell > * { position: relative; z-index: 1; }
.err-missing .err-title-box { container-type: inline-size; grid-area: title; }
.err-eyebrow {
  margin: 0 0 0.9rem;
  font: 700 0.8125rem/1.2 var(--font-readout);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--field-blue);
}
.err-nothing { max-width: 34ch; margin: 1.25rem 0 0; font: 500 1rem/1.5 var(--font-readout); color: var(--pn-ink); }
/* The punchline, as a sticker: the landing page's display face, yellow on campaign blue, hard shadow, slightly off true. */
.err-punch {
  display: inline-block;
  max-width: 100%;
  margin: 1.1rem 0 0;
  padding: 0.5em 0.8em 0.45em;
  background: var(--field-blue);
  color: var(--field-yellow);
  box-shadow: 0.3rem 0.3rem 0 var(--pn-ink);
  font: 400 clamp(0.9rem, 3.9cqi, 1.5rem)/var(--lh-display) var(--font-panel);
  text-transform: uppercase;
  text-wrap: balance;
  transform: rotate(-1.5deg);
  transform-origin: 0 50%;
  animation: err-pop 620ms cubic-bezier(0.2, 1.4, 0.4, 1) 1.1s both;
}
@keyframes err-pop {
  from { opacity: 0; transform: rotate(-6deg) scale(0.6); }
  to { opacity: 1; transform: rotate(-1.5deg); }
}
.err-missing .err-actions { grid-area: actions; }
.err-missing .facepalm { grid-area: fig; align-self: center; }
/* The copy column dissolves into the grid, so on a phone Makey can sit between the words and the buttons. */
.err-missing .err-copy-col { display: contents; }
.err-missing .err-grid {
  /* Spacer rows above and below the words, so they stay together and centred beside Makey. */
  grid-template-areas: '. fig' 'title fig' 'actions fig' '. fig';
  grid-template-rows: 1fr auto auto 1fr;
  align-items: start;
  row-gap: 1.25rem;
}
.err-missing .err-actions { margin-top: 0.5rem; }
.err-missing .err-title { font-size: clamp(1.4rem, 6.6cqi, 3.75rem); text-transform: uppercase; text-wrap: balance; color: var(--field-blue); }
.err-missing .err-rule span { color: var(--field-blue); }

@media (max-width: 56.25rem) {
  .err-missing .err-grid {
    grid-template-areas: 'title' 'fig' 'actions';
    grid-template-rows: auto;
    row-gap: 1rem;
  }
  .err-missing .err-rule { margin-bottom: 1.5rem; }
}
@media (max-width: 40rem) {
  .err-missing .err-rule span:not(:first-child) { display: none; }
  .err-missing .err-actions .key { padding-inline: 1rem; }
}

/* ── The event strip: campaign blue under the yellow field ── */
.err-event {
  display: grid;
  gap: 0.35rem 2rem;
  grid-template-columns: auto 1fr auto;
  align-items: baseline;
  padding: 1.25rem max(1.5rem, calc((100% - 82.5rem) / 2)) calc(1.25rem + env(safe-area-inset-bottom));
  background: var(--field-blue);
  color: var(--color-white);
  font-family: var(--font-readout);
}
.err-event p { margin: 0; }
.err-event-name { font: 400 1.125rem/1.2 var(--font-panel); letter-spacing: 0.02em; color: var(--field-yellow); }
.err-event-facts { font-size: 0.9375rem; font-weight: 600; letter-spacing: 0.03em; }
.err-event-mail { font-size: 0.9375rem; font-weight: 600; color: var(--color-white); text-decoration: underline; text-underline-offset: 0.2em; }
.err-event-mail:focus-visible { outline: 2px solid var(--field-yellow); outline-offset: 3px; }
@media (max-width: 56.25rem) {
  .err-event { grid-template-columns: 1fr; padding-inline: 1.5rem; }
}

/* ── The landing page's logo, with no bar around it ── */
.err-logo-link { display: block; width: fit-content; margin-bottom: 1.5rem; }
.err-logo { display: block; width: min(13.75rem, 60vw); height: auto; }

</style>

<!-- Unscoped on purpose: a scoped :global() drops the descendant part of a selector. -->
<style>
html[data-motion='paused'] .err-missing .err-punch { animation-play-state: paused; }
html[data-motion='reduced'] .err-missing .err-punch { animation: none; }
</style>
