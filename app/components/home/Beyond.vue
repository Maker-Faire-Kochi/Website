<script setup lang="ts">
/**
 * 2027 and beyond: the story closes on what this starts, on the campaign's yellow.
 */
</script>

<template>
  <section id="beyond" class="field field-yellow screen" aria-labelledby="beyond-title">
    <div class="wrap beyond">
      <div class="beyond-head">
        <h2 id="beyond-title" class="display beyond-title">2027 and beyond</h2>
      </div>
      <div>
        <p class="lede beyond-lede">
          The beginning of an annual tradition.
        </p>
        <p class="copy beyond-copy">
          Ahead of Maker Faire Kochi 2028, TinkerHub will activate its 70-plus college chapters across Kerala, expand the roadshow into a multi-city series and grow a public Kerala Maker Directory.
        </p>
        <p class="beyond-credit">
          Built together by TinkerHub Foundation, MakerGram and Kerala Startup Mission.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.beyond {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
  column-gap: clamp(2rem, 5vw, 5rem);
  align-items: end;
}

/* Sized to its column, not the screen: "BEYOND" (about 5.3em) must fit it. */
.beyond-head {
  container-type: inline-size;
}

.beyond-title {
  font-size: min(7.5rem, 18cqi);
}

.beyond-lede {
  color: var(--field-blue);
}

.beyond-copy {
  margin-top: 1rem;
}

/* The page's sign-off: who built it, set off by a blue hairline. */
.beyond-credit {
  margin-top: 1.75rem;
  max-width: 46ch;
  padding-top: 1rem;
  border-top: 2px solid var(--field-blue);
  font-family: var(--font-readout);
  font-size: 1rem;
  line-height: 1.55;
  color: var(--pn-ink);
}

@media (max-width: 900px) {
  .beyond {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 1.25rem;
  }
}
</style>
