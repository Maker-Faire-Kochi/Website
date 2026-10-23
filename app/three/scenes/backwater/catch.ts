import { rng, type Rng } from '../../core/rng'

/**
 * The catch: small fish in the net and in the deck basket, as plain numbers
 * (no three.js), stepped with the scene so it is deterministic and testable.
 *
 * Each dip, on the step the net breaks the surface going in (the sim's
 * splash), the catch is rolled from a seeded generator: some dips bring up
 * nothing (never the first), the others four to seven fish. They are in the net under the
 * water, unseen; they show once the net is out of the water again and lie in
 * its belly (a net position u, v near the middle), flapping now and then --
 * each flap throws a few drops that ring the water. At rest the scoop net
 * takes them (toHoop), carries them over the basket and tips them in
 * (toBasket): they drop into the basket's mouth (`drop`, DROP_TIME) and settle
 * on the heap there. The basket's count only ever goes up.
 */

export type FishWhere = 'off' | 'net' | 'hoop' | 'drop'

export interface Fish {
  where: FishWhere
  /** Net coordinates (0..1 each way); in the hoop, the same numbers place it in the hoop's bag. */
  u: number
  v: number
  yaw: number
  len: number
  /** Seconds into a flap, or -1 when lying still; seconds to the next flap. */
  flap: number
  next: number
  /** Dropping into the basket: seconds since it left the scoop, and the place on the heap it lands in. */
  fall: number
  slot: number
}

/** Where in the net the catch lies (u and v, both), and how long a fish is (m, nose to tail). */
export const FISH_UV: [number, number] = [0.36, 0.64]
export const FISH_LEN: [number, number] = [0.38, 0.48]
export const MAX_FISH = 7
/** How many landed fish the basket shows, in two layers (the count goes on; the heap is full). */
export const BASKET_SHOW = 6
/** Seconds a tipped fish takes to drop from the scoop into the basket. */
export const DROP_TIME = 0.4
/** Share of dips that come up empty. */
export const EMPTY_SHARE = 0.3
export const FLAP_TIME = 0.32

export class Catch {
  readonly fish: Fish[] = Array.from({ length: MAX_FISH }, () => ({ where: 'off', u: 0.5, v: 0.5, yaw: 0, len: 0.18, flap: -1, next: 1, fall: -1, slot: 0 }))
  /** Fish landed in the basket so far. */
  basket = 0
  /** Dips rolled, and how many came up empty. */
  dips = 0
  empty = 0
  /** Indices of fish that started a flap this step (for splashes). */
  readonly flapped: number[] = []
  private readonly r: Rng

  constructor(seed = 17) {
    this.r = rng(seed)
  }

  /** The net has just gone into the water: what swims into it this dip. */
  roll() {
    this.dips++
    // The first dip a visitor sees always brings something up; after that, chance.
    const empty = this.r.next() < EMPTY_SHARE && this.dips > 1
    const n = empty ? 0 : 4 + Math.floor(this.r.next() * 4)
    if (n === 0) this.empty++
    let added = 0
    for (const f of this.fish) {
      if (added >= n) break
      if (f.where !== 'off') continue
      f.where = 'net'
      // Fish slide to the belly: near the middle, never at the rim.
      f.u = this.r.range(...FISH_UV)
      f.v = this.r.range(...FISH_UV)
      f.yaw = this.r.range(0, Math.PI * 2)
      // About 0.18-0.25 m of body: pearl spot and sardine size (the unit fish is 1.04 long with its tail).
      f.len = this.r.range(...FISH_LEN)
      f.flap = -1
      f.next = this.r.range(0.3, 1.6)
      added++
    }
  }

  count(where: FishWhere) {
    let n = 0
    for (const f of this.fish) if (f.where === where) n++
    return n
  }

  /**
   * Flapping, for the fish that can be seen: in the net while it is out of
   * the water (`netShown`), or in the hoop.
   */
  step(dt: number, netShown: boolean) {
    this.flapped.length = 0
    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i]!
      if (f.where === 'drop') {
        f.fall += dt
        if (f.fall >= DROP_TIME) {
          f.where = 'off'
          f.fall = -1
        }
        continue
      }
      const shown = f.where === 'hoop' || (f.where === 'net' && netShown)
      if (!shown) {
        f.flap = -1
        continue
      }
      if (f.flap >= 0) {
        f.flap += dt
        if (f.flap >= FLAP_TIME) f.flap = -1
      }
      else {
        f.next -= dt
        if (f.next <= 0) {
          f.flap = 0
          f.next = this.r.range(0.6, 2.2)
          this.flapped.push(i)
        }
      }
    }
  }

  /** The scoop takes every fish in the net. Returns how many. */
  toHoop() {
    let n = 0
    for (const f of this.fish) {
      if (f.where !== 'net') continue
      f.where = 'hoop'
      n++
    }
    return n
  }

  /** Fish in the basket that have settled on the heap (not still dropping in). */
  get settled() {
    return this.basket - this.count('drop')
  }

  /** The scoop is tipped over the basket: its fish drop in. Returns how many. */
  toBasket() {
    let n = 0
    for (const f of this.fish) {
      if (f.where !== 'hoop') continue
      f.where = 'drop'
      f.fall = 0
      f.flap = -1
      // Onto the heap, in order; once it is full they land on its top.
      f.slot = Math.min(BASKET_SHOW - 1, this.basket + n)
      n++
    }
    this.basket += n
    return n
  }

  snapshot() {
    return JSON.stringify([this.basket, this.dips, this.empty, this.fish])
  }
}

/** A flap: a hop, a twist of the body and a flick of the tail, 0 at both ends. Returns [hop m, twist rad, tail flick rad]. */
export function flapPose(t: number, out: [number, number, number] = [0, 0, 0]) {
  if (t < 0) {
    out[0] = out[1] = out[2] = 0
    return out
  }
  const u = t / FLAP_TIME
  const env = Math.sin(Math.PI * u)
  out[0] = 0.09 * env * env
  out[1] = 0.5 * env * Math.sin(3 * Math.PI * u)
  out[2] = 0.9 * env * Math.sin(4 * Math.PI * u)
  return out
}
