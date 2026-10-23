/**
 * The cheena vala's dip cycle as a pure function of time.
 *
 * One cycle: lower the net into the water, let it soak, haul it out, then
 * rest raised until the next dip. The rest is "between cycles": a tap or the
 * dip action jumps straight to the start of the next lowering, which is
 * seamless because rest and the start of lowering hold the same angle.
 *
 * Every move eases in and out (smootherstep: zero velocity AND acceleration
 * at both ends), so the boom never starts or stops with a jolt. The haul is
 * slower to get going than the drop -- the net comes up full of water.
 */

/** Boom tilt (radians, positive raises the net end). */
export const THETA_UP = 0.32
export const THETA_DOWN = -0.15

export type Phase = 'lower' | 'soak' | 'lift' | 'rest'

export const DUR: Record<Phase, number> = { lower: 2.6, soak: 1.8, lift: 3.2, rest: 3.4 }
export const ORDER: Phase[] = ['lower', 'soak', 'lift', 'rest']
export const PERIOD = DUR.lower + DUR.soak + DUR.lift + DUR.rest

/** Smootherstep: 6u^5 - 15u^4 + 10u^3. */
export function smoother(u: number) {
  const x = Math.min(1, Math.max(0, u))
  return x * x * x * (x * (x * 6 - 15) + 10)
}

export function phaseAt(t: number): { phase: Phase, u: number } {
  let x = ((t % PERIOD) + PERIOD) % PERIOD
  for (const p of ORDER) {
    if (x < DUR[p]) return { phase: p, u: x / DUR[p] }
    x -= DUR[p]
  }
  return { phase: 'rest', u: 1 }
}

/** Boom tilt at cycle time t. Periodic in PERIOD. */
export function thetaAt(t: number): number {
  const { phase, u } = phaseAt(t)
  const span = THETA_UP - THETA_DOWN
  switch (phase) {
    case 'lower': return THETA_UP - span * smoother(u)
    // A small settle while it soaks: (1 - cos) keeps velocity zero at both ends.
    case 'soak': return THETA_DOWN + 0.006 * (1 - Math.cos(2 * Math.PI * u)) / 2
    case 'lift': return THETA_DOWN + span * smoother(u ** 1.3)
    default: return THETA_UP
  }
}

/** Seconds into the cycle at which rest begins. */
export const REST_START = DUR.lower + DUR.soak + DUR.lift

/**
 * Stepped cycle clock. Starts part-way into a rest so the first dip comes a
 * couple of seconds after the scene appears.
 */
export class DipCycle {
  t = REST_START + DUR.rest - 2.0

  step(dt: number) {
    this.t += dt
    if (this.t >= PERIOD) this.t -= PERIOD
  }

  get phase(): Phase {
    return phaseAt(this.t).phase
  }

  get theta() {
    return thetaAt(this.t)
  }

  /** Start a dip now if the net is resting raised. Returns whether it started. */
  dip(): boolean {
    if (this.phase !== 'rest') return false
    this.t = 0
    return true
  }
}
