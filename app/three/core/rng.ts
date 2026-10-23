/**
 * Seeded PRNG (mulberry32). Every bit of "randomness" on the stage -- sensor
 * noise, idle glances, wander targets -- draws from one of these, so a scene
 * replays identically from the same seed and step count.
 */
export function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    /** Approximately normal, mean 0, sd 1 (sum of uniforms). */
    gauss: () => next() + next() + next() + next() - 2,
  }
}

export type Rng = ReturnType<typeof rng>
