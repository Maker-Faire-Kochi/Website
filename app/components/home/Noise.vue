<script setup lang="ts">
/**
 * Make some noise: the music and art side of making, full screen on the
 * campaign's own yellow, with NOISE deforming as a signal driven by the noise
 * machine's real output (PretextNoiseHeadline). The line under it is the
 * campaign poster's. No event claims here: this section describes the
 * drawing, not a programme. Reaching the last panel starts the machine.
 */
const controls = [
  { action: 'play', label: 'Play' },
  { action: 'stop', label: 'Stop' },
  { action: 'knob1-up', label: 'Tone +' },
  { action: 'knob1-down', label: 'Tone −' },
  { action: 'knob2-up', label: 'Echo +' },
  { action: 'knob2-down', label: 'Echo −' },
  { action: 'plot', label: 'New drawing' },
]
</script>

<template>
  <section id="noise" class="field field-yellow chapter-field" aria-labelledby="noise-title">
    <ThreeSceneChapter
      scene="noise"
      focus="0.44 1 0 1"
      phone-focus="0 1 0 0.6"
      side="left"
      style="--chapter-ground: var(--field-yellow)"
      caption="A noise machine and a pen plotter. Sound in, drawing out."
      hint="Hold and move over the machine. Drag a knob."
      :controls="controls"
      :step-actions="[null, 'plot']"
    >
      <div class="chapter-panel">
        <h2 id="noise-title" class="display noise-title">
          <PretextNoiseHeadline text="Make some noise" />
        </h2>
        <p class="lede noise-lede">For the ones who can’t leave it alone.</p>
      </div>
      <div class="chapter-panel">
        <p class="copy">
          Music and instruments, art and illustration: the loud, colourful side of
          making. The noise machine here is playable. Hold the pointer down over it
          and move to change the pitch, drag its knobs, and watch the plotter turn
          what you play into a drawing.
        </p>
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

.noise-lede {
  margin-top: 1.25rem;
  color: var(--field-blue);
}
</style>
