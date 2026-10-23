<script setup lang="ts">
/**
 * What Maker Faire is: the idea, then its proof as a line through time -- from
 * the Bay Area in 2006, through the global network, to Kochi in 2027. The
 * figures are the network's own; Kochi's node is this faire.
 */
const stops = [
  { to: 2006, from: 1990, suffix: '', label: 'Since', note: 'Bay Area' },
  { to: 200, from: 0, suffix: '+', label: 'Licensed Faires', note: '' },
  { to: 40, from: 0, suffix: '+', label: 'Countries', note: '' },
  { to: 30, from: 0, suffix: '+', label: 'Featured Faires a year', note: '' },
]
</script>

<template>
  <section id="about" class="field field-paper screen" aria-labelledby="about-title">
    <div class="wrap what">
      <h2 id="about-title" class="display-2 what-title">What is Maker Faire?</h2>

      <div class="what-copy">
        <p class="lede">
          A global celebration of invention, creativity and hands-on learning.
        </p>
        <!-- Experimental (Pretext): this paragraph re-wraps around the pointer. -->
        <PretextFlowText class="copy what-flow" text="Since its launch in the Bay Area in 2006, Maker Faire has grown into a network of more than 200 licensed events across 40-plus countries, including 30-plus Featured Faires each year. Its two flagship editions in the United States draw over 200,000 visitors annually." />
        <p class="copy">
          Maker Faire Kochi is built collectively by TinkerHub Foundation, MakerGram and Kerala Startup Mission, giving Kerala’s labs, campuses and maker communities a shared public stage.
        </p>
      </div>

      <h3 class="label what-net">The global network</h3>
      <ol class="timeline">
        <li v-for="s in stops" :key="s.label" class="stop">
          <span class="stop-dot" aria-hidden="true" />
          <span class="stop-number">
            <BitsCountUp :to="s.to" :from="s.from" :decimals="0" :suffix="s.suffix" />
          </span>
          <span class="stop-label label">{{ s.label }}<template v-if="s.note"> · {{ s.note }}</template></span>
        </li>
        <li class="stop stop-here">
          <span class="stop-dot" aria-hidden="true" />
          <span class="stop-number">2027</span>
          <span class="stop-label label">Kochi</span>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.what {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  column-gap: clamp(2rem, 5vw, 5rem);
}

.what-title {
  grid-column: 1;
}

.what-copy {
  grid-column: 2;
}

.what-copy .lede {
  color: var(--field-blue);
}

.what-flow {
  margin-top: 1.25rem;
}

.what-net {
  grid-column: 1 / -1;
  margin-top: clamp(3.5rem, 7vw, 6rem);
  color: var(--pn-label);
}

/* A line through time: one rule, five stops, the last one ours. */
.timeline {
  grid-column: 1 / -1;
  position: relative;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 1rem;
  margin: 1.5rem 0 0;
  padding: 0;
  list-style: none;
}

.timeline::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 9px;
  height: 2px;
  background: var(--pn-ink);
}

.stop {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.stop-dot {
  width: 20px;
  height: 20px;
  border: 2px solid var(--pn-ink);
  border-radius: 50%;
  background: var(--pn-enamel);
}

.stop-number {
  margin-top: 0.5rem;
  font-family: var(--font-panel);
  font-size: clamp(2rem, 4vw, 3.5rem);
  line-height: 1;
  color: var(--pn-ink);
  font-variant-numeric: tabular-nums;
}

.stop-label {
  color: var(--pn-label);
}

.stop-here .stop-dot {
  border-color: var(--color-red-cta);
  background: var(--color-red-cta);
}

.stop-here .stop-number {
  color: var(--color-red-cta);
}

@media (max-width: 900px) {
  .what {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 1.5rem;
  }

  .what-title,
  .what-copy {
    grid-column: 1;
  }

  /* On a phone the line runs down the page instead of across it. */
  .timeline {
    grid-template-columns: minmax(0, 1fr);
    gap: 1.5rem;
    padding-left: 2.25rem;
  }

  .timeline::before {
    left: 9px;
    right: auto;
    top: 0;
    bottom: 0;
    width: 2px;
    height: auto;
  }

  .stop-dot {
    position: absolute;
    left: -2.25rem;
    top: 0.75rem;
  }

  .stop-number {
    margin-top: 0;
  }
}
</style>
