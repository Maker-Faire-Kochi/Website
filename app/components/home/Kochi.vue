<script setup lang="ts">
// Pure module (no three.js): the camera's scroll input.
import { scrollShot } from '~/three/scenes/backwater/shots'

/**
 * Why Kochi, full screen over the backwater: the cheena vala worked by its
 * crew, the world's longest-running open hardware project, with the case for
 * Kochi and the mission scrolling up beside it. Each panel moves the camera
 * (scrollShot): the whole machine, the balance (pivot, counterweights and the
 * haulers), the catch in the lifted net, and the bank with the kite. Reaching the third panel dips the net; the
 * mission drops a coconut from the palm.
 */
function onProgress(p: number) {
  scrollShot.progress = p
}

onUnmounted(() => {
  scrollShot.progress = 0
})
</script>

<template>
  <section id="kochi" class="field field-paper chapter-field" aria-labelledby="kochi-title">
    <ThreeSceneChapter
      scene="backwater"
      focus="0.44 1 0 1"
      phone-focus="0 1 0 0.6"
      side="left"
      caption="Cheena vala and coconut palms, Fort Kochi backwater. The world's longest-running open hardware project."
      hint="Tap the net or a palm."
      :controls="[{ action: 'dip', label: 'Dip the net' }, { action: 'drop-nut', label: 'Drop a coconut' }]"
      :step-actions="[null, null, 'dip', 'drop-nut']"
      @progress="onProgress"
    >
      <div class="chapter-panel field-blue">
        <h2 id="kochi-title" class="display-2">Why Kochi, why now</h2>
        <p class="lede kochi-lede">
          Kerala has the infrastructure for a thriving maker ecosystem. What it lacks is a public stage.
        </p>
      </div>
      <div class="chapter-panel">
        <p class="kochi-figure"><span>98</span> Fab Foundation network labs in India, 25 to 30 of them in Kerala</p>
        <p class="copy">
          The state is home to roughly 25 to 30 of India’s 98 Fab Foundation network labs, 369 Atal Tinkering Labs and 28 Centres for Early Innovation, with 70 more planned. Kochi, Kerala’s innovation and startup hub, is the natural place to bring that work into public view.
        </p>
      </div>
      <div class="chapter-panel">
        <p class="copy">
          Each January to March, the Kerala Literature Festival and the Kochi-Muziris Biennale draw visitors from across the world. Maker Faire Kochi adds technology and making to that season.
        </p>
      </div>
      <div class="chapter-panel field-yellow">
        <h3 class="display-3 mission-title">The mission</h3>
        <p class="lede mission-lede">To build a lasting maker culture in Kerala.</p>
        <p class="copy mission-copy">
          Maker Faire Kochi celebrates learning by building. It gives makers, students and hobbyists a reason to finish projects and share them, and connects a pathway from first workshop to incubation, Fab Academy and industry.
        </p>
      </div>
    </ThreeSceneChapter>
  </section>
</template>

<style scoped>
.kochi-lede {
  margin-top: 1.5rem;
  color: var(--on-blue);
}

.kochi-figure {
  margin: 0 0 1.25rem;
  font-family: var(--font-readout);
  font-weight: 600;
  font-size: 0.9375rem;
  line-height: 1.4;
  color: var(--pn-label);
}

.kochi-figure span {
  display: block;
  margin-bottom: 0.4rem;
  font-family: var(--font-panel);
  font-weight: 400;
  font-size: clamp(3.5rem, 7vw, 5.5rem);
  line-height: 1;
  color: var(--field-blue);
}

.mission-title,
.mission-lede {
  color: var(--field-blue);
}

.mission-lede {
  margin-top: 1rem;
}

.mission-copy {
  margin-top: 1rem;
}
</style>
