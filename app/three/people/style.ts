import type { MatKey } from '../core/kit'
import { rng } from '../core/rng'
import type { Variant } from './body'

/**
 * What a person looks like beyond the variant's silhouette: hair, glasses,
 * facial hair, how the garments are worn, and the colours.
 *
 * Everything here is picked from the seed (so a crowd of one variant is not a
 * row of twins) and can be pinned through PersonOptions.look / colors. The
 * look is part of the geometry cache key: people with the same variant AND
 * the same look share every buffer.
 *
 * COLOUR, per the guidelines: neutral first. Skin and hair are real human
 * tones (never a grey or a palette swatch). Clothes are the drawing's
 * neutrals plus at most ONE muted garment colour per person -- a turmeric
 * shirt, a leaf-green skirt -- chosen so no person competes with red (drive
 * input), cyan (selection) or the beam-blue accent, which stays reserved for
 * the one figure a scene flags with `accent`.
 */

export type HairStyle = 'short' | 'side' | 'curly' | 'receding' | 'long' | 'bun' | 'plait' | 'ponytail' | 'none'
export type Facial = 'none' | 'moustache' | 'beard'
export type Sleeves = 'short' | 'rolled' | 'long'

export interface Look {
  hair: HairStyle
  glasses: boolean
  facial: Facial
  /** Shirt and tee sleeves; kurta sleeves are always long. */
  sleeves: Sleeves
  /** Mundu variant only: the white mundu or a coloured lungi. */
  lungi: boolean
  /** Mundu variant only: hitched up and tucked at the waist (madakki kuthu), hem at the knee -- how fishers and carpenters work. */
  folded: boolean
  /** A work apron over the front (takes the 'scarf' colour role). */
  apron: boolean
}

/** Person-local tones (not in the stage palette): skin, hair and garment dyes. */
export const TONES = {
  skin1: '#E9C7A2',
  skin2: '#D7A77C',
  skin3: '#BF8A5E',
  skin4: '#A06E47',
  skin5: '#825535',
  skin6: '#633F27',
  hairBlack: '#26221F',
  hairBrown: '#4A3628',
  hairGrey: '#A9A6A0',
  hairSalt: '#6E6A65',
  cream: '#EFE8D6',
  khaki: '#B9AA8A',
  slate: '#5D646C',
  charcoal: '#3A3B3D',
  turmeric: '#C99A3E',
  leafDye: '#7E9A6E',
  clay: '#B27855',
  plum: '#73566E',
  olive: '#7B7A50',
  lungiGreen: '#5E7A5F',
  lungiMaroon: '#7C4C4A',
  leather: '#6B4A34',
  canvas: '#CDBF9E',
} as const
export type Tone = keyof typeof TONES
export type ColorKey = MatKey | Tone

export const isTone = (k: string): k is Tone => k in TONES

export type Role = 'skin' | 'top' | 'bottom' | 'hair' | 'shoe' | 'scarf'

const SKINS: Tone[] = ['skin1', 'skin2', 'skin3', 'skin3', 'skin4', 'skin4', 'skin5', 'skin6']
const NEUTRAL_TOPS: ColorKey[] = ['light', 'cream', 'mid', 'stone', 'khaki', 'slate', 'light', 'cream']
const NEUTRAL_BOTTOMS: ColorKey[] = ['charcoal', 'slate', 'khaki', 'dark', 'stone']
const DYES: Tone[] = ['turmeric', 'leafDye', 'clay', 'plum', 'olive']

interface LookSpec { hair: [HairStyle, number][], glasses: number, facial: [Facial, number][], sleeves: [Sleeves, number][] }
const LOOKS: Record<Variant, LookSpec> = {
  shirt: { hair: [['side', 3], ['short', 2], ['curly', 2], ['receding', 1]], glasses: 0.4, facial: [['none', 4], ['moustache', 3], ['beard', 2]], sleeves: [['short', 1], ['rolled', 1]] },
  kurta: { hair: [['side', 2], ['short', 2], ['curly', 1]], glasses: 0.3, facial: [['beard', 3], ['moustache', 2], ['none', 3]], sleeves: [['long', 1]] },
  mundu: { hair: [['short', 3], ['receding', 2], ['side', 2], ['curly', 1]], glasses: 0.2, facial: [['moustache', 5], ['beard', 2], ['none', 2]], sleeves: [['short', 3], ['rolled', 2]] },
  skirt: { hair: [['bun', 2], ['plait', 2], ['long', 2]], glasses: 0.3, facial: [['none', 1]], sleeves: [['short', 1]] },
  headscarf: { hair: [['none', 1]], glasses: 0.25, facial: [['none', 1]], sleeves: [['long', 1]] },
  child: { hair: [['short', 2], ['ponytail', 2], ['curly', 1]], glasses: 0.1, facial: [['none', 1]], sleeves: [['short', 1]] },
}

function weighted<T>(r: { next(): number }, list: [T, number][]): T {
  const total = list.reduce((a, [, w]) => a + w, 0)
  let x = r.next() * total
  for (const [v, w] of list) {
    x -= w
    if (x < 0) return v
  }
  return list[list.length - 1]![0]
}

/** The look for a seed, with any pinned fields applied. */
export function resolveLook(variant: Variant, seed: number, pin: Partial<Look> = {}): Look {
  const r = rng(seed * 131 + 71)
  const s = LOOKS[variant]
  const look: Look = {
    hair: weighted(r, s.hair),
    glasses: r.next() < s.glasses,
    facial: weighted(r, s.facial),
    sleeves: weighted(r, s.sleeves),
    lungi: false,
    folded: false,
    apron: false,
  }
  Object.assign(look, Object.fromEntries(Object.entries(pin).filter(([, v]) => v !== undefined)))
  // Keep the combinations physical: a headscarf hides the hair, kurta sleeves are long, only a mundu folds.
  if (variant === 'headscarf') look.hair = 'none'
  if (variant === 'kurta' || variant === 'headscarf') look.sleeves = 'long'
  if (variant !== 'mundu') { look.lungi = false; look.folded = false }
  if (variant === 'child' || variant === 'skirt' || variant === 'headscarf') look.facial = 'none'
  return look
}

export function lookKey(variant: Variant, l: Look) {
  return `${variant}|${l.hair}|${+l.glasses}|${l.facial}|${l.sleeves}|${+l.lungi}|${+l.folded}|${+l.apron}`
}

/** Colours per role: real skin and hair tones, neutral clothes, at most one dyed garment, beam blue only for `accent`. */
export function pickColors(variant: Variant, seed: number, look: Look, accent: boolean, pinned: Partial<Record<Role, ColorKey>> = {}): Record<Role, ColorKey> {
  const r = rng(seed * 31 + 5)
  const pick = <T>(list: T[], avoid: T[] = []) => {
    const ok = list.filter(k => !avoid.includes(k))
    return ok[Math.floor(r.next() * ok.length)] ?? list[0]!
  }
  const skin = pick(SKINS)
  const elder = look.hair === 'receding'
  const hair: ColorKey = elder ? pick<ColorKey>(['hairGrey', 'hairSalt', 'hairGrey']) : pick<ColorKey>(['hairBlack', 'hairBlack', 'hairBlack', 'hairBrown'])
  // One dyed garment for about half the people; which garment depends on the clothes.
  const dyed = r.next() < 0.55
  const dye = pick(DYES)
  let top = pick(NEUTRAL_TOPS)
  let bottom: ColorKey = variant === 'mundu' ? (look.lungi ? pick<ColorKey>(['lungiGreen', 'lungiMaroon', 'slate']) : 'cream') : pick(NEUTRAL_BOTTOMS)
  let scarf: ColorKey = look.apron ? pick<ColorKey>(['canvas', 'khaki', 'leather']) : pick<ColorKey>(['stone', 'cream', 'slate', 'khaki'])
  if (dyed) {
    if (variant === 'skirt') { if (r.next() < 0.5) bottom = dye; else top = dye }
    else if (variant === 'headscarf') scarf = dye
    else if (!(variant === 'mundu' && look.lungi)) top = dye
  }
  if (top === bottom) top = pick(NEUTRAL_TOPS, [bottom])
  const shoe: ColorKey = pick<ColorKey>(['leather', 'charcoal', 'dark', 'khaki'], [bottom])
  const out: Record<Role, ColorKey> = { skin, top, bottom, hair, shoe, scarf }
  for (const k of Object.keys(pinned) as Role[]) if (pinned[k]) out[k] = pinned[k]!
  // The flagged figure's one beam-blue accent wins over everything (as before).
  if (accent) {
    if (variant === 'headscarf') out.scarf = 'accent'
    else out.top = 'accent'
    if (out.bottom === 'accent' && variant !== 'headscarf') out.bottom = 'dark'
  }
  return out
}
