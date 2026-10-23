<script setup lang="ts">
import { hoverLabel as electronicsLabel } from '~/three/scenes/electronics/label'
// Pure modules (no three.js): the shot titles/notes and the camera's scroll input.
import { SHOTS, scrollShot } from '~/three/scenes/electronics/shots'

/**
 * The maker's bench, full screen: the bench holds the left of the screen
 * while the notes scroll up the right, and as each note reaches the middle of
 * the screen the camera moves in on that part of the bench. The scene reads
 * the step from `scrollShot` (app/three/scenes/electronics/shots.ts); without
 * the scene (reduced motion, no WebGL) the notes still read in order.
 */
function onProgress(p: number) {
  scrollShot.progress = p
}

onUnmounted(() => {
  scrollShot.progress = 0
})
</script>

<template>
  <section id="bench" class="field field-paper chapter-field" aria-labelledby="bench-title">
    <ThreeSceneChapter
      scene="electronics"
      :hover-label="electronicsLabel"
      focus="0 0.6 0 1"
      phone-focus="0 1 0 0.6"
      side="right"
      caption="Electronics & IoT: a maker at the bench, soldering a single-board computer to a breadboard of LEDs, a button, a buzzer and a servo."
      hint="Hover a part to name it. Tap the board to boot it."
      :controls="[{ action: 'boot', label: 'Boot' }, { action: 'button', label: 'Press button' }, { action: 'servo', label: 'Sweep servo' }, { action: 'chirp', label: 'Chirp' }, { action: 'solder', label: 'Solder' }, { action: 'measure', label: 'Measure' }, { action: 'drill', label: 'Drill' }, { action: 'saw', label: 'Saw' }, { action: 'lamp', label: 'Lamp' }, { action: 'wave', label: 'Wave' }]"
      @progress="onProgress"
    >
      <div v-for="(s, i) in SHOTS" :key="s.id" class="chapter-panel">
        <span class="label step-n" aria-hidden="true">{{ String(i + 1).padStart(2, '0') }} / {{ String(SHOTS.length).padStart(2, '0') }}</span>
        <h2 v-if="i === 0" id="bench-title" class="display-2">Electronics &amp; IoT</h2>
        <h3 class="display-3" :class="{ 'step-sub': i === 0 }">{{ s.title }}</h3>
        <p class="copy step-note">{{ s.note }}</p>
      </div>
    </ThreeSceneChapter>
  </section>
</template>

<style scoped>
.step-n {
  display: block;
  margin-bottom: 1rem;
  color: var(--pn-label);
}

.chapter-panel:first-child .display-2 {
  color: var(--field-blue);
}

.step-sub {
  margin-top: 1.25rem;
}

.step-note {
  margin-top: 0.9rem;
}
</style>
