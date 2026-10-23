<script setup lang="ts">
/**
 * Three ways in, on blue, after the visitor has seen what the faire holds;
 * then the direct call to makers. The one red key on the field is the action.
 */
const invitations = [
  {
    title: 'Exhibit',
    body: 'Inventors, engineers, students, hobbyists and hardware startups: present your project and show how it works.',
    href: '/interestform',
    cta: 'Get involved',
  },
  {
    title: 'Learn',
    body: 'Hands-on workshops and live demonstrations from makers across Kerala’s labs, campuses and communities.',
    href: '#categories',
    cta: 'See who fits',
  },
  {
    title: 'Visit',
    body: 'Two days in Kochi, 5 and 6 February 2027. Free and open to the public.',
    href: '#countdown',
    cta: 'See the dates',
  },
]
</script>

<template>
  <section id="take-part" class="field field-blue screen" aria-labelledby="ways-in">
    <div class="wrap">
      <h2 id="ways-in" class="display-2">Three ways in</h2>

      <ul class="ways">
        <li v-for="item in invitations" :key="item.title" class="way">
          <h3 class="display-3 way-title">{{ item.title }}</h3>
          <p class="copy way-body">{{ item.body }}</p>
          <a :href="item.href" class="key way-key">{{ item.cta }}</a>
        </li>
      </ul>

      <div class="call">
        <div>
          <h3 class="display-2 call-title">Have a project to share?</h3>
          <p class="copy call-text">
            Tell us what you are building and how you would like to take part.
          </p>
        </div>
        <a href="/interestform" class="key key-red call-key">Get Involved</a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ways {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(1.5rem, 3vw, 3rem);
  margin: clamp(2.5rem, 5vw, 4rem) 0 0;
  padding: 0;
  list-style: none;
}

.way {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding-top: 1.25rem;
  border-top: 3px solid var(--field-yellow);
}

.way-title {
  color: var(--field-yellow);
}

.way-body {
  flex: 1 1 auto;
  color: var(--on-blue-label);
}

.way-key {
  align-self: flex-start;
  color: var(--on-blue);
}

.call {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1.5rem 3rem;
  margin-top: clamp(4rem, 8vw, 6rem);
  padding-top: 2rem;
  border-top: 2px solid rgba(255, 255, 255, 0.35);
}

.call-text {
  margin-top: 0.75rem;
  color: var(--on-blue-label);
}

.call-key {
  min-height: 56px;
  padding-inline: 2rem;
  font-size: 1rem;
}

@media (max-width: 900px) {
  .ways {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
