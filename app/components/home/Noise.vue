<script setup lang="ts">
/**
 * Make some noise: the music and art side of making, full screen on the
 * campaign's own yellow, with NOISE deforming as a signal driven by the noise
 * machine's real output (PretextNoiseHeadline). The line under it is the
 * campaign poster's. No event claims here: this section describes the
 * drawing, not a programme. Reaching the panel starts the machine.
 */
</script>

<template>
  <section id="noise" class="field field-yellow chapter-field" aria-labelledby="noise-title">
    <ThreeSceneChapter
      scene="noise"
      focus="0.44 1 0 1"
      phone-focus="0 1 0 1"
      poster-version="phone-story-1"
      side="left"
      style="--chapter-ground: var(--field-yellow); --chapter-tail: 55svh; --chapter-tail-phone: 60svh"
      caption="A noise machine and a pen plotter. Sound in, drawing out."
      :step-actions="['plot']"
    >
      <div class="chapter-panel">
        <h2 id="noise-title" class="display noise-title">
          <PretextNoiseHeadline text="Make some noise" />
        </h2>
        <p class="lede noise-lede">For the ones who can’t leave it alone.</p>
        <ReadMore class="noise-more">
          <p class="copy">
            Music and instruments, art and illustration: the loud, colourful side
            of making. The noise machine here is playable: hold the pointer down
            over it and move to change the pitch, drag its knobs, and watch the
            plotter turn what you play into a drawing.
          </p>
        </ReadMore>
      </div>
    </ThreeSceneChapter>
  </section>
</template>

<style scoped>
.noise-title {
  color: var(--field-blue);
  font-size: clamp(2.6rem, 5.2vw, 4.75rem);
}

/* The headline's deforming word takes the field's blue too, not its own accent. */
.noise-title :deep(.nh-g.is-wave) {
  color: var(--field-blue);
}

.noise-more {
  margin-top: 1.1rem;
}

.noise-lede {
  margin-top: 1.25rem;
  color: var(--field-blue);
}
</style>
