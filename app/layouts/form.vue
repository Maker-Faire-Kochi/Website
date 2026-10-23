<script setup lang="ts">
const route = useRoute()

useHead({
  meta: [{ name: 'theme-color', content: '#F6F6F3' }],
})

const sheet = computed(() =>
  route.path.startsWith('/volunteer') ? 'Media volunteer' : 'Interest form',
)
</script>

<template>
  <div class="form-layout maker-app">
    <NuxtRouteAnnouncer />
    <BitsClickSpark selector=".key, .spark" />
    <a href="#form-main" class="skip-link">Skip to form</a>
    <SheetBar
      :sheet="sheet"
      :links="[
        { href: '/', label: 'Home' },
        { href: '/interestform', label: 'Interest' },
        { href: '/volunteer', label: 'Volunteer' },
      ]"
    />
    <main id="form-main" tabindex="-1">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.form-layout {
  min-height: 100svh;
  color: var(--pn-ink);
}

#form-main:focus {
  outline: none;
}
</style>
