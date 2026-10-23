<script setup>
import { Mail } from '@lucide/vue'
import { CONTACT_EMAIL, INSTAGRAM_URL } from '~/composables/useCountdown'

/**
 * The close of the poster: an ink field with the mark, the two real contact
 * routes, the story's sections and the people building it.
 *
 * The newsletter form was REMOVED at the owner's request. It never sent
 * anything anywhere -- there was no endpoint and no storage -- so removing it
 * was the honest outcome. If a form ever returns here, RESTORE THE NAV RAIL'S
 * KEYBOARD AVOIDANCE with it (see MakerHeader.vue).
 */
const sections = [
  { label: 'The event', href: '#top' },
  { label: 'What is Maker Faire?', href: '#about' },
  { label: 'Why Kochi, why now', href: '#kochi' },
  { label: 'Where are the makers?', href: '#categories' },
  { label: 'Woodwork & joinery', href: '#workshop' },
  { label: 'Electronics & IoT', href: '#bench' },
  { label: 'Make some noise', href: '#noise' },
  { label: 'Three ways in', href: '#take-part' },
  { label: 'When', href: '#countdown' },
  { label: '2027 and beyond', href: '#beyond' },
]

const builders = [
  'TinkerHub Foundation',
  'MakerGram',
  'Kerala Startup Mission',
]
</script>

<template>
  <footer class="maker-footer field field-ink">
    <div class="wrap footer-container">
      <div class="footer-top">
        <div class="footer-brand">
          <!-- The real lockup, never typeset: it carries its own white plaque
               and cyan frame, so it needs no colour handling on ink. -->
          <picture>
            <source srcset="/img/logo/mf-kochi-long@2x.webp 2x, /img/logo/mf-kochi-long.webp 1x" type="image/webp" />
            <img
              src="/img/logo/mf-kochi-long.png"
              width="216"
              height="36"
              class="footer-logo"
              alt="Maker Faire Kochi"
              loading="lazy"
              decoding="async"
            />
          </picture>
          <p class="brand-desc">
            Kerala’s first licensed Maker Faire, celebrating invention, creativity and hands-on learning.
          </p>
          <!-- @lucide/vue ships no brand icons, so Instagram is an inline SVG
               drawn at Lucide's weight; Mail is Lucide. -->
          <div class="social-links">
            <a :href="INSTAGRAM_URL" target="_blank" rel="noopener noreferrer" class="social-link">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect>
                <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path>
                <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line>
              </svg>
              Instagram
            </a>
            <a :href="`mailto:${CONTACT_EMAIL}`" class="social-link">
              <Mail :size="18" :stroke-width="2" aria-hidden="true" />
              Email
            </a>
          </div>
        </div>

        <nav class="footer-col" aria-labelledby="footer-sections">
          <h2 id="footer-sections" class="label col-title">On this page</h2>
          <ul class="link-list">
            <li v-for="s in sections" :key="s.href">
              <a :href="s.href" class="footer-link">{{ s.label }}</a>
            </li>
          </ul>
        </nav>

        <div class="footer-col">
          <h2 class="label col-title">Contact</h2>
          <a :href="`mailto:${CONTACT_EMAIL}`" class="contact-email">{{ CONTACT_EMAIL }}</a>

          <h2 class="label col-title builders-title">Collectively building</h2>
          <ul class="builder-list">
            <li v-for="name in builders" :key="name">{{ name }}</li>
          </ul>
        </div>
      </div>

      <div class="footer-bottom">
        <p class="credits">© 2027 Maker Faire Kochi. All rights reserved.</p>
        <p class="legal-text">
          Maker Faire is a registered trademark of Make Community LLC. Maker Faire Kochi is independently organized and operated under license from Make Community LLC.
        </p>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.maker-footer {
  /* Ends clear of the floating nav. */
  padding-bottom: calc(var(--rail-h) + 2.5rem + env(safe-area-inset-bottom));
  font-family: var(--font-readout);
}

.footer-top {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 3.5fr) minmax(0, 3.5fr);
  gap: 2.5rem clamp(2rem, 5vw, 5rem);
}

.footer-logo {
  display: block;
  width: 216px;
  height: auto;
}

.brand-desc {
  margin: 1.25rem 0 0;
  max-width: 34ch;
  font-size: 1rem;
  line-height: 1.6;
  color: var(--on-blue-label);
}

.social-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.5rem;
  margin-top: 1.5rem;
}

.social-link,
.footer-link,
.contact-email {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
  font-weight: 600;
  color: var(--on-blue);
  text-decoration: underline;
  text-decoration-thickness: 1.5px;
  text-underline-offset: 0.25em;
}

.social-link:hover,
.footer-link:hover,
.contact-email:hover {
  color: var(--field-yellow);
}

.col-title {
  margin: 0 0 0.5rem;
  color: var(--field-yellow);
}

.link-list,
.builder-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.footer-link {
  min-height: 36px;
  font-weight: 500;
  text-decoration: none;
}

.footer-link:hover {
  text-decoration: underline;
}

.contact-email {
  word-break: break-word;
}

.builders-title {
  margin-top: 1.75rem;
}

.builder-list li {
  padding: 0.25rem 0;
  font-weight: 500;
  color: var(--on-blue);
}

.footer-bottom {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  gap: 1rem clamp(2rem, 5vw, 5rem);
  margin-top: clamp(3rem, 6vw, 5rem);
  padding-top: 1.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.25);
  font-size: 0.875rem;
  line-height: 1.6;
  color: var(--on-blue-label);
}

.footer-bottom p {
  margin: 0;
}

@media (max-width: 900px) {
  .footer-top,
  .footer-bottom {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
