/**
 * The ONE motion state for the page.
 *
 *   reduced  -- prefers-reduced-motion is on. Wins over everything; nothing moves
 *               and the Pause key is hidden because there is nothing for it to stop.
 *   paused   -- the visitor pressed Pause. Persisted, and never resumed by
 *               anything except the visitor (not by a tab switch, not by
 *               leaving reduced motion, not by a WebGL context restore).
 *   running  -- everything decorative may move.
 *
 * Every decorative motion source reads this: the 3D stage, the React-Bits
 * ports, ClickSpark and the scroll reveal. That is what makes the Pause key a
 * real WCAG 2.2.2 mechanism rather than a button that stops one canvas.
 */
const STORAGE_KEY = 'mfk-motion-paused'

export type Motion = 'running' | 'paused' | 'reduced'

export function useMotion() {
  const userPaused = useState('motion-user-paused', () => false)
  const reduced = useState('motion-reduced', () => false)
  const ready = useState('motion-ready', () => false)
  const mounted = useState('motion-mounted', () => false)

  const state = computed<Motion>(() => (reduced.value ? 'reduced' : userPaused.value ? 'paused' : 'running'))
  /**
   * For TEMPLATES only. The server cannot know the stored pause or the OS
   * setting, so until the app has mounted this reports what the server
   * rendered ('running'); markup that depends on it would otherwise mismatch
   * during hydration. Logic (whether to animate) must use `state`.
   */
  const view = computed<Motion>(() => (mounted.value ? state.value : 'running'))

  /** Client-only. Reads the stored choice and the media query before anything starts animating. */
  function init() {
    if (import.meta.server || ready.value) return
    try {
      userPaused.value = localStorage.getItem(STORAGE_KEY) === '1'
    }
    catch {}
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    reduced.value = mq.matches
    mq.addEventListener('change', (e) => {
      reduced.value = e.matches
    })
    ready.value = true
  }

  function setPaused(paused: boolean) {
    userPaused.value = paused
    try {
      localStorage.setItem(STORAGE_KEY, paused ? '1' : '0')
    }
    catch {}
  }

  return { state, view, ready, mounted, init, setPaused, toggle: () => setPaused(!userPaused.value) }
}
