import { ESCAPE, MOTION, gear, type GearId } from './gears'

/**
 * The hover label, for a DOM leader beside the machine room. Written only by
 * this scene, every frame something is hovered; read by the Countdown sheet
 * in its own requestAnimationFrame. x, y are slot-relative CSS px of the
 * hovered part's centre. Plain mutable object on purpose (no Vue reactivity
 * on a value written 60 times a second).
 */
export const hoverLabel = { text: '', x: 0, y: 0, visible: false }

/** Gear pairs in the direction the power flows, crank first. */
const DRIVE: [GearId, GearId][] = [['A', 'B'], ['C', 'D'], ['D', 'E']]

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a
}

const period = (s: number) => (s % 60 === 0 ? `${s / 60} min` : `${s} s`)

/** e.g. "Gear B · 12 teeth · 3:1 · 1 turn / 20 s" -- the ratio is driver : driven teeth. */
export function gearText(id: GearId | 'W' | 'crank'): string {
  if (id === 'crank') return `Crank · 1 turn = 1 minute ahead · drag to wind`
  if (id === 'W') return `Escape wheel · ${ESCAPE.teeth} teeth · half a tooth a second`
  const g = gear(id)
  const turn = `1 turn / ${period(MOTION[g.shaft].period)}`
  const pair = DRIVE.find(d => d[1] === id)
  if (!pair) return `Gear ${id} · ${g.teeth} teeth · ${id === 'A' ? 'on the crank' : 'on the same shaft as B'} · ${turn}`
  const p = gear(pair[0]).teeth
  const k = gcd(p, g.teeth)
  const extra = id === 'D' ? ' · drives the seconds drum' : ''
  return `Gear ${id} · ${g.teeth} teeth · ${p / k}:${g.teeth / k} · ${turn}${extra}`
}
