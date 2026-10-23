<script setup lang="ts">
/**
 * The homepage, told as a story in colour fields (see .field in main.css):
 * the event (yellow poster) / what a Maker Faire is / why Kochi, over the
 * cheena vala / the faire's aisle: every discipline, one stall each / a
 * carpenter at work / a maker at the bench / make some noise (yellow) / three
 * ways in (blue) / when and where, counted down by the machine / 2027 and
 * beyond (yellow). The scenes are full-screen chapters (ThreeSceneChapter):
 * the drawing holds the screen while the words scroll over one side.
 *
 * Scroll reveal: text below the fold rises in as it enters. The hidden state
 * exists only once this script has run, so no-JS visitors see a whole page.
 * Figures are never revealed this way: their drawing is on the canvas and
 * would not fade with them.
 */
let io: IntersectionObserver | null = null
const { state: motion } = useMotion()

onMounted(() => {
  // Paused or reduced: everything is simply shown in its final place.
  if (motion.value !== 'running' || typeof IntersectionObserver === 'undefined') return
  const els = document.querySelectorAll<HTMLElement>('.field .wrap > :not(.hero-copy), .maker-footer .footer-container')
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      e.target.classList.add('is-in')
      io?.unobserve(e.target)
    }
  }, { rootMargin: '0px 0px -8% 0px' })
  for (const el of els) {
    const r = el.getBoundingClientRect()
    if (r.top < window.innerHeight) continue
    el.classList.add('reveal')
    io.observe(el)
  }
})

// Pausing mid-page must not strand sections that have not risen in yet.
watch(motion, (m) => {
  if (m === 'running') return
  io?.disconnect()
  document.querySelectorAll('.reveal:not(.is-in)').forEach(el => el.classList.add('is-in'))
})

onUnmounted(() => io?.disconnect())
</script>

<template>
  <PageLoader />
  <BitsClickSpark />
  <!-- NOT positioned: a positioned <main> would paint the fields' backgrounds
       over the 3D canvas (see .field in main.css). -->
  <main id="main" tabindex="-1">
    <HomeHero />
    <HomeWhat />
    <HomeKochi />
    <HomeDomains />
    <HomeWorkshop />
    <HomeBench />
    <HomeNoise />
    <HomeTakePart />
    <HomeWhen />
    <HomeBeyond />
  </main>
</template>

<style>
.reveal {
  opacity: 0;
  transform: translateY(24px);
  transition: opacity 700ms var(--ease-out), transform 700ms var(--ease-out);
}

.reveal.is-in {
  opacity: 1;
  transform: none;
}
</style>
