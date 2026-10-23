/**
 * Hidden fun, page side. Recognises the triggers and hands the egg's name to
 * whoever listens (the hero, which runs it as a scene action). Nothing here
 * animates by itself, so the Pause key and reduced motion are respected by
 * the scene that receives the egg.
 *
 *   type "dance"            -> dance
 *   type "conga"            -> conga
 *   up up down down left right left right b a  -> party
 *   click the hero logo five times              -> line-up
 *   no input for a minute                       -> sleep (any input wakes them)
 *
 * Keys typed into a field never count.
 */
export type Egg = 'dance' | 'conga' | 'party' | 'line-up' | 'sleep'

const WORDS: Record<string, Egg> = { dance: 'dance', conga: 'conga' }
const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a']
const IDLE_MS = 60_000
const LOGO_CLICKS = 5
const LOGO_WINDOW_MS = 2_000

export function useEasterEggs(onEgg: (egg: Egg) => void) {
  let typed = ''
  let keys: string[] = []
  let clicks: number[] = []
  let idle: ReturnType<typeof setTimeout> | undefined
  let asleep = false

  function fire(egg: Egg) {
    typed = ''
    keys = []
    onEgg(egg)
  }

  function resetIdle() {
    clearTimeout(idle)
    asleep = false
    idle = setTimeout(() => {
      asleep = true
      fire('sleep')
    }, IDLE_MS)
  }

  function onKey(e: KeyboardEvent) {
    resetIdle()
    const t = e.target as HTMLElement | null
    if (t?.closest('input, textarea, select, [contenteditable]')) return
    const k = e.key.toLowerCase()
    keys = [...keys, k].slice(-KONAMI.length)
    if (keys.join() === KONAMI.join()) return fire('party')
    if (k.length !== 1) return
    typed = (typed + k).slice(-8)
    for (const [word, egg] of Object.entries(WORDS)) {
      if (typed.endsWith(word)) return fire(egg)
    }
  }

  function onLogoClick() {
    const now = performance.now()
    clicks = [...clicks.filter(t => now - t < LOGO_WINDOW_MS), now]
    if (clicks.length >= LOGO_CLICKS) {
      clicks = []
      fire('line-up')
    }
  }

  function onActivity() {
    if (asleep) resetIdle()
    else if (idle) resetIdle()
  }

  onMounted(() => {
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onActivity, { passive: true })
    window.addEventListener('wheel', onActivity, { passive: true })
    resetIdle()
  })

  onUnmounted(() => {
    clearTimeout(idle)
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('pointerdown', onActivity)
    window.removeEventListener('wheel', onActivity)
  })

  return { onLogoClick }
}
