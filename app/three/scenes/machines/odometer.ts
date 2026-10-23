/**
 * The mechanical counter as plain numbers: which wheels exist, how many faces
 * each has, what is printed on every face, and where every wheel stands for a
 * given count. Pure -- the drums, the tests and the hover labels all read it.
 *
 * The count c is the number of whole seconds left to the event (fractional
 * only while the wheels are rolling). Wheels read DD : HH : MM : SS.
 *
 * Carry is the real odometer law: a wheel only moves while every wheel to its
 * right is passing from its lowest digit round to its highest -- the units
 * wheel's last second of travel turns the tens wheel through one face, and so
 * on up. Counting down, that is 0 -> 9 (or 0 -> 5, or 00 -> 23).
 *
 * Faces are chosen so each step of the count is exactly ONE face of roll:
 * ten faces for 0-9, twelve (0-5 twice) for the tens of seconds and minutes,
 * nine (0-2 three times) for the tens of hours. The units of hours is the one
 * wheel that cannot be regular -- 23 -> 00 is not a step of one on 0-9 -- so
 * on the day carry it rolls the short way, three faces, as real clock
 * counters with a 24-hour drum do.
 */

export type WheelKey = 'dH' | 'dT' | 'dO' | 'hT' | 'hO' | 'mT' | 'mO' | 'sT' | 'sO'

export interface WheelSpec {
  key: WheelKey
  faces: number
  /** Digit printed on face k. */
  label: (k: number) => number
  /** Group the wheel belongs to, for spacing and the plate under it. */
  group: 'days' | 'hours' | 'minutes' | 'seconds'
}

const ten = (k: number) => k % 10
const six = (k: number) => k % 6
const three = (k: number) => k % 3

const SPEC: Record<WheelKey, WheelSpec> = {
  dH: { key: 'dH', faces: 10, label: ten, group: 'days' },
  dT: { key: 'dT', faces: 10, label: ten, group: 'days' },
  dO: { key: 'dO', faces: 10, label: ten, group: 'days' },
  hT: { key: 'hT', faces: 9, label: three, group: 'hours' },
  hO: { key: 'hO', faces: 10, label: ten, group: 'hours' },
  mT: { key: 'mT', faces: 12, label: six, group: 'minutes' },
  mO: { key: 'mO', faces: 10, label: ten, group: 'minutes' },
  sT: { key: 'sT', faces: 12, label: six, group: 'seconds' },
  sO: { key: 'sO', faces: 10, label: ten, group: 'seconds' },
}

/**
 * Wheels left to right. Two day wheels from 99 days out; a third (hundreds)
 * while the faire is 100 or more days away -- the scene picks when it loads.
 */
export function wheels(dayWheels: 2 | 3): WheelSpec[] {
  const keys: WheelKey[] = dayWheels === 3 ? ['dH', 'dT', 'dO'] : ['dT', 'dO']
  return [...keys, 'hT', 'hO', 'mT', 'mO', 'sT', 'sO'].map(k => SPEC[k as WheelKey])
}

const mod = (a: number, n: number) => ((a % n) + n) % n

/**
 * Odometer position of the place with value P: whole steps, plus the
 * fraction of the step in progress only while everything below it is on its
 * last unit of travel (c mod P in [P-1, P)). Continuous and monotonic in c.
 */
export function carried(c: number, P: number): number {
  const r = mod(c, P)
  return Math.floor(c / P) + Math.max(0, r - (P - 1))
}

/**
 * Face position (in faces, continuous) of every wheel at count c, written to
 * `out` in wheels() order. A drum's angle is -position * 2pi / faces.
 */
export function wheelPositions(c: number, list: WheelSpec[], out: Float64Array | number[]) {
  const ch = carried(c, 3600)
  const hc = mod(ch, 24)
  const day = Math.floor(ch / 24)
  for (let i = 0; i < list.length; i++) {
    const w = list[i]!
    let p: number
    switch (w.key) {
      case 'sO': p = mod(c, 10); break
      case 'sT': p = mod(carried(c, 10), 12); break
      case 'mO': p = mod(carried(c, 60), 10); break
      case 'mT': p = mod(carried(c, 600), 12); break
      case 'hO':
        // 0-9, 0-9, 0-3; across the day carry (hc in [23, 24)) the short way back from 0 to 3.
        p = hc < 20 ? mod(hc, 10) : hc < 23 ? hc - 20 : 3 - 3 * (hc - 23)
        break
      case 'hT': {
        const t = hc < 23 ? carried(hc, 10) : 2 + (hc - 23)
        p = mod(3 * day + t, 9)
        break
      }
      case 'dO': p = mod(carried(c, 86400), 10); break
      case 'dT': p = mod(carried(c, 864000), 10); break
      case 'dH': p = mod(carried(c, 8640000), 10); break
    }
    out[i] = p
  }
  return out
}

/** The digit a wheel shows at a (resting or nearly resting) position. */
export function digitAt(w: WheelSpec, position: number): number {
  return w.label(mod(Math.round(position), w.faces))
}

/**
 * The digits the counter shows at count c, as the DD HH MM SS strings
 * useCountdown() produces (days padded to the number of day wheels).
 */
export function reading(c: number, list: WheelSpec[]): string {
  const pos = wheelPositions(c, list, new Array<number>(list.length))
  return list.map((w, i) => digitAt(w, pos[i]!)).join('')
}

/** Straight arithmetic reading for comparison: what useCountdown's partsFor() shows for n whole seconds. */
export function expectedReading(n: number, dayWheels: 2 | 3): string {
  const pad = (v: number, d = 2) => String(Math.floor(v)).padStart(d, '0')
  return pad(n / 86400, dayWheels) + pad((n % 86400) / 3600) + pad((n % 3600) / 60) + pad(n % 60)
}

/**
 * A split-flap unit at continuous position p (in faces). Between whole
 * positions a and a + 1 exactly one flap is moving, hinged at the card's
 * middle: `theta` is its angle from straight up (0, still covering the upper
 * half of face a + 1) to hanging down (pi, showing the lower half of face a
 * on its back). Counting down, p falls from a + 1 to a, so the flap falls
 * forward and the new figure is uncovered from the top -- the way a real
 * split-flap display turns. At a whole position the flap is down and the
 * unit simply shows face a.
 */
export function flapState(p: number, faces: number) {
  const a = Math.floor(p + 1e-9)
  const u = Math.max(0, p - a)
  return { face: mod(a, faces), from: mod(a + 1, faces), theta: (1 - u) * Math.PI }
}
