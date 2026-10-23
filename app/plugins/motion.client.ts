/**
 * Resolves the page's motion state (useMotion) BEFORE any component mounts, so
 * a stored Pause is honoured from the first frame, and mirrors it onto
 * <html data-motion="..."> for CSS-only animations to key off.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const { state, init, mounted } = useMotion()
  init()
  // The state the page LOADED in, never updated: one-shot entrances key off it.
  document.documentElement.dataset.motionStart = state.value
  // NOT app:mounted: that fires while async layouts are still hydrating.
  // The root suspense resolving is the point where hydration is complete.
  nuxtApp.hook('app:suspense:resolve', () => {
    mounted.value = true
  })
  watch(state, (s) => {
    document.documentElement.dataset.motion = s
  }, { immediate: true })
})
