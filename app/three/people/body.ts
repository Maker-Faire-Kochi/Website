/**
 * Body proportions for the fair visitors, pure data (no three.js) so the
 * motion controller, the geometry builder and the tests read one table.
 *
 * Proportions follow standard anthropometric fractions of stature (ankle
 * 0.039 H, knee 0.285 H, hip joint 0.53 H, shoulder joint 0.818 H, upper arm
 * 0.186 H, forearm 0.146 H, hand 0.108 H) so a figure stands, reaches and
 * crouches like a person rather than a mannequin. The child is drawn with a
 * child's proportions (bigger head, shorter legs), not an adult scaled down.
 *
 * A VARIANT fixes the silhouette (height, build, garments), so every person of
 * one variant shares the same geometry; the seed only picks colours and the
 * timing of their idle motion.
 */

export const VARIANTS = ['shirt', 'kurta', 'mundu', 'skirt', 'headscarf', 'child'] as const
export type Variant = typeof VARIANTS[number]

/** Garments that have their own geometry piece (and so their own colour role). */
export type Lower = 'trousers' | 'shorts' | 'mundu' | 'skirt'
export type Top = 'shirt' | 'kurta' | 'tee'

export interface Dims {
  variant: Variant
  /** Standing height, metres. */
  H: number
  /** Width/depth factor of the body and clothes. */
  build: number
  top: Top
  lower: Lower
  /** Hem of a long garment hanging from the pelvis (mundu/skirt) or the top's tail (kurta), metres below the pelvis origin; 0 = none. */
  hem: number
  /** Half-width of that garment at the waist and at the hem. */
  hemW0: number
  hemW1: number
  hemDepth: number
  longSleeves: boolean
  headscarf: boolean
  /** Drawn with a woman's proportions (narrower shoulders and waist, wider hips). */
  female: boolean
  hair: 'short' | 'long' | 'bun' | 'none'
  // Joints, metres.
  hipW: number
  L1: number
  L2: number
  ankleH: number
  footLen: number
  heel: number
  footW: number
  /** Spine origin above the pelvis origin (the waist). */
  waistY: number
  /** Waist to the top of the torso (neck base). */
  spineLen: number
  shoulderX: number
  /** Shoulder joint height in the spine frame. */
  shoulderY: number
  UA: number
  FA: number
  hand: number
  neck: number
  headH: number
  headD: number
  headW: number
  /** Limb thicknesses. */
  thigh: number
  calf: number
  arm: number
  torsoW: number
  torsoD: number
  /** Nominal standing hip-joint height (knees almost straight). */
  standY: number
}

interface Spec {
  H: number
  build: number
  top: Top
  lower: Lower
  hem?: number
  longSleeves?: boolean
  headscarf?: boolean
  hair: Dims['hair']
  child?: boolean
  female?: boolean
}

const SPECS: Record<Variant, Spec> = {
  shirt: { H: 1.82, build: 1.0, top: 'shirt', lower: 'trousers', hair: 'short' },
  kurta: { H: 1.72, build: 0.94, top: 'kurta', lower: 'trousers', longSleeves: true, hair: 'short' },
  mundu: { H: 1.67, build: 1.16, top: 'shirt', lower: 'mundu', hair: 'short' },
  skirt: { H: 1.6, build: 0.92, top: 'tee', lower: 'skirt', hair: 'bun', female: true },
  headscarf: { H: 1.56, build: 1.02, top: 'kurta', lower: 'trousers', longSleeves: true, headscarf: true, hair: 'none', female: true },
  child: { H: 1.16, build: 1.0, top: 'tee', lower: 'shorts', hair: 'short', child: true },
}

export function dimsFor(variant: Variant): Dims {
  const s = SPECS[variant]
  const H = s.H
  const b = s.build
  // Fractions of stature: adult vs child (about six years old).
  const f = s.child
    ? { ankle: 0.042, knee: 0.27, hip: 0.47, shoulder: 0.775, neckBase: 0.8, ua: 0.17, fa: 0.14, hand: 0.09, head: 0.182, hipW: 0.052, shoulderX: 0.105 }
    : { ankle: 0.039, knee: 0.285, hip: 0.53, shoulder: 0.818, neckBase: 0.835, ua: 0.186, fa: 0.146, hand: 0.108, head: 0.1333, hipW: 0.052, shoulderX: 0.112 }
  const L2 = (f.knee - f.ankle) * H
  const L1 = (f.hip - f.knee) * H
  const ankleH = f.ankle * H
  const reach = L1 + L2
  // Knee almost straight (about 9 deg): a person standing at ease.
  const standY = ankleH + 0.997 * reach
  const waistY = 0.06 * H
  const spineLen = f.neckBase * H - standY - waistY
  const lowerHem = s.lower === 'mundu'
    ? standY - 0.05 * H
    : s.lower === 'skirt'
      ? standY - 0.075 * H
      : 0
  const kurtaHem = s.top === 'kurta' ? standY - (s.headscarf ? 0.33 : 0.3) * H : 0
  const hem = lowerHem || kurtaHem
  return {
    variant,
    H,
    build: b,
    top: s.top,
    lower: s.lower,
    hem,
    hemW0: (s.lower === 'trousers' || s.lower === 'shorts' ? 0.1 : 0.097) * H * b,
    hemW1: (s.lower === 'skirt' ? 0.14 : s.lower === 'mundu' ? 0.108 : 0.112) * H * b,
    hemDepth: (s.lower === 'trousers' || s.lower === 'shorts' ? 0.118 : 0.115) * H * b,
    longSleeves: !!s.longSleeves,
    headscarf: !!s.headscarf,
    female: !!s.female,
    hair: s.hair,
    hipW: f.hipW * H * b,
    L1,
    L2,
    ankleH,
    footLen: (s.child ? 0.16 : 0.152) * H,
    heel: 0.035 * H,
    footW: 0.05 * H * Math.sqrt(b),
    waistY,
    spineLen,
    shoulderX: f.shoulderX * H * b,
    shoulderY: f.shoulder * H - standY - waistY,
    UA: f.ua * H,
    FA: f.fa * H,
    hand: f.hand * H,
    // Neck base to chin: what is left of stature after the torso and the head (7.5 heads adult, 5.5 child).
    neck: (1 - f.neckBase - f.head) * H,
    headH: f.head * H,
    headD: f.head * H * 0.88,
    headW: f.head * H * 0.72,
    thigh: 0.078 * H * b,
    calf: 0.058 * H * b,
    arm: 0.05 * H * b,
    torsoW: 0.122 * H * b,
    torsoD: 0.125 * H * b,
    standY,
  }
}
