type ClarityQueue = ((...args: unknown[]) => void) & { q?: unknown[][] }

/** Optional analytics, loaded after the page is interactive without an SDK bundle. */
export default defineNuxtPlugin((nuxtApp) => {
  const projectId = String(useRuntimeConfig().public.clarityProjectId || '').trim()
  if (import.meta.dev || !/^[a-z0-9]+$/i.test(projectId)) return

  const excluded = () => /^\/(admin|lab)(\/|$)/.test(location.pathname)
  if (excluded()) return

  function load() {
    if (excluded() || document.getElementById('microsoft-clarity')) return
    const win = window as Window & { clarity?: ClarityQueue }
    win.clarity ||= Object.assign((...args: unknown[]) => {
      (win.clarity!.q ||= []).push(args)
    }, { q: [] as unknown[][] })
    const script = document.createElement('script')
    script.id = 'microsoft-clarity'
    script.async = true
    script.src = `https://www.clarity.ms/tag/${projectId}`
    document.head.appendChild(script)
  }

  nuxtApp.hook('app:mounted', () => {
    setTimeout(() => {
      if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 2000 })
      else load()
    }, 1000)
  })
})
