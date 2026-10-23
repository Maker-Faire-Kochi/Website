<script setup lang="ts">
/**
 * The carpenter, full screen: one panel per job, and reaching a panel sets
 * the carpenter to that job (stepActions), so scrolling tells the work in
 * order: cut, true, joint, assemble.
 */
const steps = [
  { title: 'Woodwork & Joinery', note: 'Not every maker works in code. Wood, edge tools and patience: the oldest kind of making on the faire floor.', action: null },
  { title: 'Cut to the line', note: 'The saw takes the board to length, the cut started on the waste side of a pencil line.', action: 'saw' },
  { title: 'True the face', note: 'The plane takes shavings off until the board is flat and square.', action: 'plane' },
  { title: 'Cut the joint', note: 'Mallet and chisel chop a mortise for each leg to sit in.', action: 'chisel' },
  { title: 'A stool', note: 'Four legs, the rails and a seat: every part made at this bench, shown here pulled apart.', action: 'stool' },
]
</script>

<template>
  <section id="workshop" class="field field-paper chapter-field" aria-labelledby="workshop-title">
    <ThreeSceneChapter
      scene="workshop"
      focus="0.44 1 0 1"
      phone-focus="0 1 0 0.6"
      side="left"
      caption="A carpenter at the bench: saw, plane, mallet and chisel, and a stool in exploded view."
      hint="Hover a tool, tap it to use it."
      :controls="[{ action: 'saw', label: 'Saw' }, { action: 'plane', label: 'Plane' }, { action: 'chisel', label: 'Chisel' }, { action: 'stool', label: 'Stool' }, { action: 'wave', label: 'Wave' }]"
      :step-actions="steps.map(s => s.action)"
    >
      <div v-for="(s, i) in steps" :key="s.title" class="chapter-panel">
        <span class="label step-n" aria-hidden="true">{{ String(i + 1).padStart(2, '0') }} / {{ String(steps.length).padStart(2, '0') }}</span>
        <h2 v-if="i === 0" id="workshop-title" class="display-2">{{ s.title }}</h2>
        <h3 v-else class="display-3">{{ s.title }}</h3>
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

.step-note {
  margin-top: 0.9rem;
}

.chapter-panel:first-child .display-2 {
  color: var(--field-blue);
}
</style>
