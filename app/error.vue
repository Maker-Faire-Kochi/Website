<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()

const code = computed(() => props.error?.statusCode ?? 500)
const missing = computed(() => code.value === 404)
const codeLabel = computed(() => String(code.value).padStart(3, '0'))

useSeoMeta({
  title: () => `${code.value} — Maker Faire Kochi`,
  description: () =>
    missing.value
      ? 'That sheet is not in the drawing set for Maker Faire Kochi 2027.'
      : 'Something jammed while drawing this page.',
})

function go(path: string) {
  clearError({ redirect: path })
}
</script>

<template>
  <div class="err maker-app">
    <header class="err-bar">
      <a href="/" class="err-brand" @click.prevent="go('/')">
        <img class="mark" src="/img/logo/apple-touch-icon.png" alt="" width="28" height="28" />
        <span>Maker Faire Kochi</span>
      </a>
      <span class="err-sheet">{{ missing ? 'Missing sheet' : 'Fault' }}</span>
      <nav class="err-nav" aria-label="Error sheet">
        <a href="/" class="err-link" @click.prevent="go('/')">Home</a>
        <a href="/interestform" class="err-link" @click.prevent="go('/interestform')">Interest</a>
        <a href="/volunteer" class="err-link" @click.prevent="go('/volunteer')">Volunteer</a>
      </nav>
    </header>

    <main class="err-shell">
      <header class="err-rule" aria-hidden="true">
        <span>Sht {{ codeLabel }} / ERR</span>
        <span>{{ missing ? 'Not in set' : 'Fault' }}</span>
        <span>Maker Faire Kochi · 2027</span>
      </header>

      <div class="err-grid">
        <div class="err-copy-col">
          <h1 class="err-title">
            <template v-if="missing">
              Sheet <span class="err-accent">missing</span>
            </template>
            <template v-else>
              Plot <span class="err-accent">jammed</span>
            </template>
          </h1>

          <p class="err-lede">
            <template v-if="missing">
              This path is not filed in the drawing set. It may be mistyped, or the
              sheet was never cut.
            </template>
            <template v-else>
              {{ error.statusMessage || 'Something went wrong while drawing this page.' }}
            </template>
          </p>

          <p class="err-note">
            The Faire is still on the bench. Go home, send interest, or join the media
            team.
          </p>

          <!-- The story: the route breaks here; the robot stops at the gap. -->
          <RouteBot v-if="missing" class="err-routebot" />

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

        <aside class="err-card" aria-hidden="true">
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

.err-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: stretch;
  background: var(--pn-enamel);
  border-bottom: 2px solid var(--pn-ink);
  font-family: var(--font-readout);
}

.err-brand {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 1.5rem;
  border-right: 1px solid var(--pn-ink);
  font-weight: 500;
  font-size: 0.8rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--pn-ink);
}

.mark {
  width: 28px;
  height: 28px;
}

.err-sheet {
  align-self: center;
  padding: 0 1.5rem;
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--pn-label);
}

.err-nav {
  display: flex;
}

.err-link {
  display: inline-flex;
  align-items: center;
  padding: 0 1.1rem;
  border-left: 1px solid var(--pn-ink);
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--pn-ink);
}

.err-link:hover {
  background: rgba(0, 174, 239, 0.08);
}

.err-link:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
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
  margin: 0;
  font-family: var(--font-panel);
  font-size: clamp(3rem, 8vw, 4.75rem);
  font-weight: 400;
  line-height: var(--lh-display);
  text-transform: uppercase;
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

.err-routebot {
  max-width: 34rem;
  margin: 1.75rem 0 0;
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
  .err-bar {
    grid-template-columns: 1fr auto;
  }

  .err-sheet,
  .err-brand span {
    display: none;
  }

  .err-link {
    padding: 0 0.7rem;
    font-size: 0.6875rem;
  }

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
</style>
