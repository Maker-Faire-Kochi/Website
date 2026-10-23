<script setup lang="ts">
import { hoverLabel as machinesLabel } from '~/three/scenes/machines/label'
import { EVENT, EVENT_START, EVENT_END, CONTACT_EMAIL, useCountdown } from '~/composables/useCountdown'

/**
 * When and where. The date leads; the 3D machine is the ONE countdown on the
 * page (its odometer reads the true time to opening). The ticking figures are
 * also in the DOM, visually hidden, without aria-live (a value that changes
 * every second is noise to a screen reader; the date carries the fact).
 */
const { units, phase } = useCountdown()

/** "6 February 2027" set as "6" / "February 2027", so the range breaks cleanly. */
const [endDay, ...endRest] = EVENT.rangeEnd.label.split(' ')
const endMonth = endRest.join(' ')

const { origin: requestOrigin } = useRequestURL({ xForwardedHost: true, xForwardedProto: true })
const origin = useRuntimeConfig().public.siteUrl || requestOrigin

/** The event as structured data: search results, link previews and calendars read this, not pixels. */
useHead({
  script: [
    {
      type: 'application/ld+json',
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Event',
        'name': 'Maker Faire Kochi 2027',
        'startDate': EVENT_START.toISOString(),
        'endDate': EVENT_END.toISOString(),
        'eventStatus': 'https://schema.org/EventScheduled',
        'eventAttendanceMode': 'https://schema.org/OfflineEventAttendanceMode',
        'description':
          'Kerala’s first licensed Maker Faire. A festival of invention, creativity and hands-on learning in Kochi, 5–6 February 2027, at The Grounds @ Chakola Mill. Built together by TinkerHub Foundation, MakerGram and Kerala Startup Mission.',
        'url': origin,
        'image': [`${origin}/img/logo/mf-kochi-square-512.png`],
        'location': {
          '@type': 'Place',
          'name': EVENT.venueLabel,
          'hasMap': EVENT.venueMapUrl,
          'address': {
            '@type': 'PostalAddress',
            'addressLocality': EVENT.placeLocality,
            'addressRegion': EVENT.placeRegion,
            'addressCountry': EVENT.placeCountry,
          },
        },
        // Free is price 0: omitting offers reads as "unknown", not "free".
        'offers': {
          '@type': 'Offer',
          'price': '0',
          'priceCurrency': 'INR',
          'availability': 'https://schema.org/InStock',
          'validFrom': new Date().toISOString(),
          'url': origin,
        },
        'organizer': [
          { '@type': 'Organization', 'name': 'TinkerHub Foundation', 'email': CONTACT_EMAIL },
          { '@type': 'Organization', 'name': 'MakerGram' },
          { '@type': 'Organization', 'name': 'Kerala Startup Mission', 'alternateName': 'KSUM' },
        ],
      }),
    },
  ],
})
</script>

<template>
  <section id="countdown" class="field field-blue chapter-field" aria-labelledby="when-title">
    <ThreeSceneChapter
      scene="machines"
      :hover-label="machinesLabel"
      focus="0.44 1 0 1"
      phone-focus="0 1 0 0.6"
      side="left"
      style="--chapter-ground: var(--field-blue)"
      caption="The countdown, cranked out by a gear train: days, hours, minutes and seconds to the opening."
      hint="Drag the red crank. Hover a gear."
      :controls="[{ action: 'crank', label: 'Turn the crank' }, { action: 'reset', label: 'Reset' }]"
    >
      <div class="chapter-panel field-yellow">
        <h2 id="when-title" class="display-2 when-title">
          Two days in Kochi.<br />
          Makers from across Kerala.
        </h2>
        <p class="when-date">
          <time :datetime="EVENT.rangeStart.iso">{{ EVENT.rangeStart.label }}</time>&ndash;<time :datetime="EVENT.rangeEnd.iso">{{ endDay }}</time>
          <span class="when-month">{{ endMonth }}</span>
        </p>
        <template v-if="phase === 'upcoming'">
          <div class="visually-hidden" role="group" aria-label="Time remaining until Maker Faire Kochi opens on 5 February 2027">
            <span v-for="u in units" :key="u.key">{{ u.value }} {{ u.label }} </span>
          </div>
        </template>
        <p v-else-if="phase === 'live'" class="lede when-live">
          Maker Faire Kochi is open. Join us.
        </p>
        <p v-else class="lede when-live">
          Thank you for being part of Maker Faire Kochi 2027.
        </p>
      </div>

      <div class="chapter-panel field-ink">
        <dl class="when-fields">
          <div>
            <dt class="label">Opens</dt>
            <dd>{{ EVENT.gatesLabel }}</dd>
          </div>
          <div>
            <dt class="label">Venue</dt>
            <dd>
              <a :href="EVENT.venueMapUrl" target="_blank" rel="noopener noreferrer">{{ EVENT.venueLabel }}</a>
            </dd>
          </div>
          <div>
            <dt class="label">Admission</dt>
            <dd>{{ EVENT.admissionLabel }}</dd>
          </div>
        </dl>
      </div>
    </ThreeSceneChapter>
  </section>
</template>

<style scoped>
.when-title {
  font-size: clamp(1.75rem, 3vw, 2.75rem);
}

.when-date {
  margin: 1.75rem 0 0;
  font-family: var(--font-panel);
  font-size: clamp(3rem, 6.5vw, 5.5rem);
  line-height: 1;
  color: var(--field-blue);
}

.when-month {
  display: block;
  font-size: 0.5em;
  margin-top: 0.15em;
}

.when-fields {
  display: grid;
  gap: 1.5rem;
  margin: 0;
}

.when-fields dt {
  color: var(--on-blue-label);
}

.when-fields dd {
  margin: 0.35rem 0 0;
  font-family: var(--font-panel);
  font-size: clamp(1.2rem, 2vw, 1.6rem);
  line-height: 1.25;
  color: var(--field-yellow);
}

.when-fields a {
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 0.2em;
}

.when-live {
  margin-top: 1.5rem;
  color: var(--color-red-cta);
}
</style>
