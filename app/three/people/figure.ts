import * as THREE from 'three'
import type { Dims } from './body'
import {
  angleTable, emptyLines, polyline, secAtY, seRadius, shell, surface, surfPoint, sweep, tube,
  type LineData, type Sec, type V3,
} from './geo'
import { B, skirtSplit } from './motion'
import type { Look, Role } from './style'

/**
 * The figure, part by part, each authored in its own bone's frame (see
 * motion.ts for the frames: pelvis at the hip joints, spine from the waist,
 * head from the neck base, limbs hanging along -Y, feet with the sole at
 * y = -ankleH). person.ts merges the parts per colour role into rigidly
 * skinned meshes, so the number of parts costs nothing at draw time.
 *
 * Anatomy follows the stature fractions in body.ts; garments are shells a few
 * millimetres outside the body they dress, so a sleeve is a sleeve and a hem
 * is an edge with a hairline on it. Details that a drawing would draw -- a
 * placket, a pocket, a mundu's kasavu border, a trouser crease, a brow -- are
 * explicit hairlines, never extra colours: the person keeps its few draw calls.
 *
 * Sides: index 0 / side +1 is the person's LEFT (+X in the body frame).
 * A hand's palm faces -side * X in the hand frame with the thumb toward +Z
 * (the grip maths in motion.ts and the workshop's grips rely on this).
 */

export interface Part {
  bone: number
  role: Role
  geo: THREE.BufferGeometry
  m: THREE.Matrix4
  /** Explicit always-drawn hairlines, in the part's frame (before m). */
  lines?: LineData
  /** Crease threshold for this part's own edges (deg); 0 = no automatic edges. */
  crease?: number
  /** Draw the open rims of the part (default true); false where a rim is a seam hidden in cloth; 'noStart' keeps all but the first rim. */
  rims?: boolean | 'noStart'
  /** A garment hanging from the hips: authored in the pelvis frame, weighted across hips, thighs and shins. */
  legs?: boolean
  /** Per-vertex shade (multiplies the role colour), from the bone-local position. */
  color?: (p: V3) => [number, number, number]
}

interface AddOpts { m?: THREE.Matrix4, lines?: LineData, crease?: number, rims?: boolean | 'noStart', legs?: boolean, color?: (p: V3) => [number, number, number] }

const PI = Math.PI
const I4 = () => new THREE.Matrix4()
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x)
/** Short crease arcs on a tube's surface: angle range th0..th1 at heights ys (cloth folds at a bend). */
function creases(keys: Sec[], ys: number[], th0: number, th1: number, out: number, l: LineData) {
  for (const y of ys) {
    const pts: V3[] = []
    for (let k = 0; k <= 4; k++) {
      const th = th0 + (th1 - th0) * k / 4
      const p = surfPoint(keys, th, y, out)
      p[1] += 0.004 * out / 0.0008 * Math.sin(Math.PI * k / 4) * 0.25
      pts.push(p)
    }
    polyline(l, pts)
  }
}

const sstep = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }

/** Piecewise smooth table lookup over t in [0, 1]. */
function tab(table: [number, number][], t: number) {
  if (t <= table[0]![0]) return table[0]![1]
  for (let i = 0; i < table.length - 1; i++) {
    const [t0, v0] = table[i]!, [t1, v1] = table[i + 1]!
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0)
      return v0 + (v1 - v0) * u * u * (3 - 2 * u)
    }
  }
  return table[table.length - 1]![1]
}

export function partsFor(d: Dims, look: Look): Part[] {
  const H = d.H
  const b = d.build
  const fem = d.female
  const kid = d.variant === 'child'
  const L = d.spineLen
  const parts: Part[] = []
  const add = (bone: number, role: Role, geo: THREE.BufferGeometry, o: AddOpts = {}) => {
    parts.push({ bone, role, geo, m: o.m ?? I4(), lines: o.lines, crease: o.crease, rims: o.rims, legs: o.legs, color: o.color })
  }

  // ── Proportions shared by several parts ─────────────────────────────────
  const wW = (fem ? 0.074 : kid ? 0.088 : 0.084) * H * b // waist half-width
  const hipA = (d.hipW + d.thigh * 0.5) * (fem ? 1.04 : 0.96)
  const nr = (kid ? 0.03 : fem ? 0.027 : 0.03) * H // neck radius
  const chestA = (fem ? 0.09 : kid ? 0.092 : 0.1) * H * b
  const depth = (kid ? 0.07 : 0.064) * H * b // torso half-depth
  const ra = 0.023 * H * Math.sqrt(b) * (kid ? 0.95 : 1) // arm radius
  const lowerRole: Role = 'bottom'

  // ── Torso (spine) ───────────────────────────────────────────────────────
  // Waist to neck base; the chest sits forward, the shoulders slope to the neck.
  // An untucked shirt hangs over the hips (and over a mundu's knot); a tee is
  // tucked into a skirt; a kurta runs on into its tail (the pelvis band).
  const untucked = d.top !== 'kurta' && d.lower !== 'skirt'
  const hemY = d.top === 'kurta' ? -0.101 * H : untucked ? -0.048 * H : 0.004 * H
  const hipCover = { a: hipA * 1.05 + 0.01 * H, b: 0.062 * H * b + 0.014 * H }
  const torsoKeys: Sec[] = [
    untucked
      ? { y: hemY, a: hipCover.a, b: hipCover.b, z: 0.002 * H }
      : d.top === 'kurta'
        // The kurta's body runs on over the hips and its hip band (which carries the tail) comes out from under it.
        // (Down over the hips to where its side slits open: the front and back panels
        // carry on from under its hem, which is drawn.)
        ? { y: hemY, a: hipA * 1.1 + 0.018 * H, b: 0.074 * H * b + 0.016 * H, z: 0.001 * H }
        // Tucked in: the tee narrows under the waistband, so the band always covers it.
        : { y: hemY, a: wW * 0.92, b: depth * 0.9, z: 0.002 * H },
    ...(d.top === 'kurta' ? [{ y: -0.048 * H, a: hipA + 0.018 * H, b: 0.068 * H * b + 0.015 * H, z: 0.002 * H }] : []),
    untucked
      ? { y: -0.012 * H, a: wW * 0.5 + hipCover.a * 0.5, b: depth * 0.5 + hipCover.b * 0.5, z: 0.003 * H }
      : d.top === 'kurta' ? { y: 0.0, a: wW, b: depth * 0.98, z: 0.002 * H } : { y: 0.022 * H, a: wW * 0.97, b: depth * 0.95, z: 0.002 * H },
    { y: 0.3 * L, a: Math.max(wW * (fem ? 0.98 : 1.04) + (kid ? 0.004 * H : 0), d.shoulderX * 0.84), b: depth * 0.97, z: 0.007 * H },
    { y: 0.58 * L, a: Math.max(chestA * 0.96, d.shoulderX * 0.94), b: depth * (fem ? 1.1 : 1.06), z: (fem ? 0.007 : 0.004) * H },
    { y: 0.78 * L, a: Math.max(chestA, d.shoulderX * 0.98 + 0.004 * H), b: depth * (fem ? 1.05 : 1.04), z: 0 },
    // The shoulder reaches over the joint, so the arm grows out from under it.
    // The trapezius slopes from the neck to the shoulder joint, where the arm's
    // deltoid (blended into the torso, rig.ts) takes over: one silhouette.
    { y: Math.max(0.8 * L, d.shoulderY - 0.03 * H), a: Math.max(chestA * 1.02, d.shoulderX * 0.98 + 0.006 * H), b: depth * 0.9, z: 0.003 * H },
    { y: d.shoulderY - 0.008 * H, a: d.shoulderX + 0.008 * H, b: depth * 0.82, z: 0.001 * H },
    { y: d.shoulderY + 0.006 * H, a: d.shoulderX + 0.002 * H, b: depth * 0.72, z: 0 },
    { y: L - 0.002 * H, a: d.shoulderX * 0.76, b: depth * 0.62, z: -0.004 * H },
    { y: L + 0.007 * H, a: nr * 1.5, b: nr * 1.3, z: -0.003 * H },
    // The shirt closes round the neck (it ends inside the collar band, never a lid).
    { y: L + 0.012 * H, a: nr * 1.08, b: nr * 1.1, z: -0.001 * H },
  ].map(k => ({ ...k, e: 2.5 }))
  const torsoAt = (th: number, y: number, out = 0) => surfPoint(torsoKeys, th, clamp(y, hemY, L + 0.012 * H), out)
  {
    const lines = emptyLines()
    // Side seams, from the hem up to below the armpit (above it they ran under the arm
    // and showed through it in broken dashes when the arm moved).
    for (const th of [0, PI]) {
      const pts: V3[] = []
      for (let k = 0; k <= 8; k++) pts.push(torsoAt(th, hemY + (0.66 * L - hemY) * k / 8, 0.0006 * H))
      polyline(lines, pts)
    }
    if (d.top === 'shirt') {
      // Placket a little off centre, and a pocket on the left breast.
      const pts: V3[] = []
      for (let k = 0; k <= 8; k++) {
        const y = hemY + (L - 0.05 * H - hemY) * k / 8
        pts.push(torsoAt(PI / 2 - 0.05, y, 0.0008 * H))
      }
      polyline(lines, pts)
      const pk: V3[] = []
      const px0 = 0.25, px1 = 0.55, py0 = 0.6 * L, py1 = 0.74 * L
      for (const [u, v] of [[px0, py1], [px0, py0], [px1, py0], [px1, py1]] as const) pk.push(torsoAt(PI / 2 - u, v, 0.0008 * H))
      polyline(lines, pk)
    }
    else if (d.top === 'kurta') {
      // The kurta's front slit with three buttons.
      const pts: V3[] = []
      for (let k = 0; k <= 4; k++) pts.push(torsoAt(PI / 2, L - 0.02 * H - 0.3 * L * k / 4, 0.0008 * H))
      polyline(lines, pts)
      for (let k = 1; k <= 3; k++) {
        const y = L - 0.02 * H - 0.3 * L * k / 4 + 0.01 * H
        polyline(lines, [torsoAt(PI / 2 - 0.04, y, 0.001 * H), torsoAt(PI / 2 + 0.04, y, 0.001 * H)])
      }
    }
    // Closed under the collar: when the head bows, the neck tilts but there is no hollow to see into.
    add(B.spine, 'top', tube(torsoKeys, 22, 2, { capStart: d.top !== 'kurta' }), { lines, rims: true })
  }

  // Collars and necklines.
  if (!d.headscarf) {
    const tall = d.top === 'kurta' ? 0.024 : d.top === 'shirt' ? 0.02 : 0.01
    const keys: Sec[] = [
      { y: L + 0.002 * H, a: nr * 1.5 + 0.003 * H, b: nr * 1.3 + 0.003 * H, z: -0.002 * H },
      { y: L + tall * 0.5 * H, a: nr * 1.12 + 0.004 * H, b: nr * 1.14 + 0.004 * H, z: 0.0 },
      { y: L + tall * H, a: nr * 1.06 + 0.004 * H, b: nr * 1.08 + 0.004 * H, z: 0.001 * H },
    ]
    add(B.spine, 'top', tube(keys, 20, 2, { capStart: false, capEnd: false }), { crease: 60 })
    // Its inside wall, so a bowed head never shows a hollow ring.
    const inner = keys.map(k => ({ ...k, a: k.a - 0.0025 * H, b: k.b - 0.0025 * H }))
    add(B.spine, 'top', tube(inner, 20, 2, { capStart: false, capEnd: false, inward: true }), { crease: 0 })
    if (d.top === 'shirt') {
      // Open V at the throat (skin) and two collar points lying on the chest.
      const v = [torsoAt(PI / 2 - 0.3, L - 0.002 * H, 0.0012 * H), torsoAt(PI / 2, L - 0.04 * H, 0.0012 * H), torsoAt(PI / 2 + 0.3, L - 0.002 * H, 0.0012 * H)]
      add(B.spine, 'skin', plate(v, 0.0015 * H), { crease: 30 })
      for (const s of [1, -1]) {
        const p = [
          torsoAt(PI / 2 - s * 0.04, L - 0.004 * H, 0.0035 * H),
          torsoAt(PI / 2 - s * 0.5, L + 0.006 * H, 0.0035 * H),
          torsoAt(PI / 2 - s * 0.36, L - 0.024 * H, 0.0035 * H),
        ]
        add(B.spine, 'top', plate(p, 0.002 * H), { crease: 30 })
      }
    }
  }

  // ── Pelvis ──────────────────────────────────────────────────────────────
  const pelvisKeys: Sec[] = [
    { y: -0.08 * H, a: hipA * 0.5, b: 0.04 * H * b, z: -0.002 * H },
    { y: -0.06 * H, a: hipA * 0.9, b: 0.05 * H * b, z: 0.0 },
    { y: -0.03 * H, a: hipA, b: 0.054 * H * b, z: -0.002 * H },
    { y: 0.012 * H, a: hipA * 0.97, b: 0.058 * H * b, z: -0.002 * H },
    // The waist sits inside the shirt even when the seated pelvis rolls back.
    { y: d.waistY, a: wW * 0.97, b: depth * 0.9, z: 0.001 * H },
    { y: d.waistY + 0.02 * H, a: wW * 0.9, b: depth * 0.84, z: 0.001 * H },
  ].map(k => ({ ...k, e: 2.3 }))
  // Under a full-length mundu or skirt the hips and thighs are never seen: the
  // garment's upper piece follows the thighs. Skip them (a folded mundu shows the knees).
  const covered = (d.lower === 'mundu' && !look.folded) || d.lower === 'skirt'
  if (!covered) add(B.pelvis, lowerRole, tube(pelvisKeys, 14, 2, { capEnd: false }))

  // ── Legs ────────────────────────────────────────────────────────────────
  const trousers = d.lower === 'trousers'
  const shorts = d.lower === 'shorts'
  const bareShin = !trousers
  const sandals = d.variant === 'mundu' || d.variant === 'skirt' || d.variant === 'kurta'
  for (const [th, sh, ft, side] of [[B.thL, B.shL, B.ftL, 1], [B.thR, B.shR, B.ftR, -1]] as const) {
    const loose = trousers || shorts ? 1.05 : 1
    const thighKeys: Sec[] = [
      { y: 0.016 * H, a: 0.03 * H * b * loose, b: 0.032 * H * b * loose, z: 0.004 * H },
      { y: -0.02 * H, a: 0.04 * H * b * loose, b: 0.042 * H * b * loose, z: 0.002 * H },
      { y: -0.45 * d.L1, a: 0.037 * H * b * loose, b: 0.039 * H * b * loose, z: 0.003 * H },
      { y: -0.85 * d.L1, a: 0.03 * H * b * Math.min(loose, 1.04), b: 0.031 * H * b * Math.min(loose, 1.04), z: 0.002 * H },
      { y: -d.L1 - 0.012 * H, a: 0.027 * H * b, b: 0.028 * H * b, z: 0.001 * H },
    ]
    if (shorts) {
      const cut = -0.5 * d.L1
      const k2 = thighKeys.filter(k => k.y > cut + 0.02 * H)
      k2.push({ y: cut, a: 0.039 * H * b, b: 0.041 * H * b, z: 0.003 * H })
      add(th, 'bottom', tube(k2, 10, 2), { crease: 60 })
      add(th, 'skin', tube([
        { y: cut + 0.02 * H, a: 0.034 * H * b, b: 0.036 * H * b, z: 0.003 * H },
        { y: -0.8 * d.L1, a: 0.03 * H * b, b: 0.031 * H * b, z: 0.002 * H },
        { y: -d.L1 - 0.012 * H, a: 0.027 * H * b, b: 0.028 * H * b, z: 0.001 * H },
      ], 12, 2))
    }
    else if (!covered) {
      const lines = emptyLines()
      if (trousers) {
        // The pressed crease down the front of the leg.
        const pts: V3[] = []
        for (let k = 0; k <= 6; k++) pts.push(surfPoint(thighKeys, PI / 2, -0.06 * H - (d.L1 - 0.05 * H) * k / 6, 0.0006 * H))
        polyline(lines, pts)
      }
      // Folds behind the knee.
      if (trousers) creases(thighKeys, [-d.L1 + 0.006 * H, -d.L1 + 0.02 * H], -PI / 2 - 0.6, -PI / 2 + 0.6, 0.0008 * H, lines)
      add(th, 'bottom', tube(thighKeys, 10, 2), { lines })
    }
    // Shin: a calf behind, a knee dome on top (the knee never shows a gap when it bends).
    const shinKeys: Sec[] = trousers
      ? [
          { y: 0.026 * H, a: 0.018 * H * b, b: 0.019 * H * b, z: 0.002 * H },
          { y: 0.012 * H, a: 0.028 * H * b, b: 0.029 * H * b, z: 0.002 * H },
          { y: -0.35 * d.L2, a: 0.029 * H * b, b: 0.03 * H * b, z: -0.001 * H },
          { y: -0.8 * d.L2, a: 0.026 * H * b, b: 0.027 * H * b, z: 0.001 * H },
          { y: -d.L2 + 0.012 * H, a: 0.027 * H * b, b: 0.028 * H * b, z: 0.002 * H },
        ]
      : covered
        ? [
            // Under a skirt or mundu the knee stays inside the cloth even when seated.
            { y: -0.025 * H, a: 0.02 * H * b, b: 0.021 * H * b, z: 0.0 },
            { y: -0.04 * H, a: 0.026 * H * b, b: 0.027 * H * b, z: -0.002 * H },
            { y: -0.28 * d.L2, a: 0.027 * H * b, b: 0.029 * H * b, z: -0.004 * H },
            { y: -0.7 * d.L2, a: 0.019 * H * b, b: 0.02 * H * b, z: -0.001 * H },
            { y: -d.L2, a: 0.0155 * H, b: 0.017 * H, z: 0 },
            { y: -d.L2 - 0.008 * H, a: 0.015 * H, b: 0.016 * H, z: 0 },
          ]
        : [
          { y: 0.024 * H, a: 0.016 * H * b, b: 0.017 * H * b, z: 0.003 * H },
          { y: 0.008 * H, a: 0.026 * H * b, b: 0.027 * H * b, z: 0.002 * H },
          { y: -0.28 * d.L2, a: 0.027 * H * b, b: 0.029 * H * b, z: -0.004 * H },
          { y: -0.7 * d.L2, a: 0.019 * H * b, b: 0.02 * H * b, z: -0.001 * H },
          { y: -d.L2, a: 0.0155 * H, b: 0.017 * H, z: 0 },
          { y: -d.L2 - 0.008 * H, a: 0.015 * H, b: 0.016 * H, z: 0 },
        ]
    {
      const lines = emptyLines()
      if (trousers) {
        const pts: V3[] = []
        for (let k = 0; k <= 5; k++) pts.push(surfPoint(shinKeys, PI / 2, 0.005 * H - (d.L2 - 0.04 * H) * k / 5, 0.0006 * H))
        polyline(lines, pts)
        // The break: the hem rests on the shoe and folds once above it.
        creases(shinKeys, [-d.L2 + 0.03 * H], PI / 2 - 0.9, PI / 2 + 0.9, 0.0008 * H, lines)
      }
      add(sh, bareShin ? 'skin' : 'bottom', tube(shinKeys, 10, 2), { lines })
    }
    // Feet.
    if (sandals) {
      add(ft, 'skin', footGeo(d, side, 'foot'))
      add(ft, 'shoe', footGeo(d, side, 'sole'), { crease: 35 })
      add(ft, 'shoe', footGeo(d, side, 'strap'), { crease: 35 })
    }
    else {
      const g = footGeo(d, side, 'shoe')
      add(ft, 'shoe', g, { lines: shoeLines(d, side) })
    }
  }

  // ── Arms and hands ──────────────────────────────────────────────────────
  for (const [ua, fa, hand, side] of [[B.uaL, B.faL, B.handL, 1], [B.uaR, B.faR, B.handR, -1]] as const) {
    // The deltoid's top stays under the shoulder of the torso, so the arm
    // grows out of the shoulder instead of sitting on it like a pad.
    const armKeys: Sec[] = [
      { y: 0.005 * H, a: ra * 0.45, b: ra * 0.5, x: -side * 0.012 * H },
      { y: -0.002 * H, a: ra * 0.88, b: ra * 0.85, x: -side * 0.005 * H },
      { y: -0.022 * H, a: ra * 1.05, b: ra * 1.0 },
      { y: -0.5 * d.UA, a: ra * 0.92, b: ra * 0.94 },
      { y: -0.85 * d.UA, a: ra * 0.8, b: ra * 0.84 },
      { y: -d.UA, a: ra * 0.74, b: ra * 0.78 },
      { y: -d.UA - 0.012 * H, a: ra * 0.58, b: ra * 0.62 },
    ]
    const sleeveLen = d.longSleeves || look.sleeves === 'long' || look.sleeves === 'rolled'
      ? 1.01
      : d.top === 'tee' ? 0.42 : 0.58
    const full = sleeveLen >= 1
    const sleeveKeys = armKeys
      .filter(k => full || k.y > -sleeveLen * d.UA + 0.01 * H)
      .map(k => ({ ...k, a: k.a * 1.05 + 0.0025 * H, b: k.b * 1.05 + 0.0025 * H }))
    const sEnd = full ? null : secAtY(armKeys, -sleeveLen * d.UA)
    if (sEnd) sleeveKeys.push({ y: -sleeveLen * d.UA, a: sEnd.a * 1.1 + 0.003 * H, b: sEnd.b * 1.1 + 0.003 * H, x: sEnd.x })
    const sl = emptyLines()
    // Folds in the crook of the elbow where a full sleeve bunches when the arm bends.
    if (full) creases(sleeveKeys, [-d.UA + 0.012 * H, -d.UA + 0.026 * H], PI / 2 - 0.55, PI / 2 + 0.55, 0.0008 * H, sl)
    // No rim line or cap edge at the top: it lies just under the shoulder, and as the arm
    // swings forward those lines broke through it as dark smudges.
    add(ua, 'top', tube(sleeveKeys, 12, 2, { capStart: false }), { crease: 60, lines: sl, rims: 'noStart' })
    if (sleeveLen < 1) {
      // The bare arm starts well up inside the sleeve: it used to start below the hem, a
      // hollow ring you could see into with the arm raised.
      const y0 = -sleeveLen * d.UA + 0.025 * H
      const s0 = secAtY(armKeys, y0)
      add(ua, 'skin', tube([{ ...s0, y: y0, a: s0.a * 0.97, b: s0.b * 0.97 }, ...armKeys.filter(k => k.y < y0 - 0.005 * H)], 10, 2))
    }
    const faKeys: Sec[] = [
      { y: 0.018 * H, a: ra * 0.5, b: ra * 0.55 },
      { y: 0.004 * H, a: ra * 0.78, b: ra * 0.8 },
      { y: -0.22 * d.FA, a: ra * 0.86, b: ra * 0.82 },
      { y: -0.65 * d.FA, a: ra * 0.62, b: ra * 0.68 },
      { y: -d.FA, a: 0.0118 * H, b: 0.0158 * H },
      { y: -d.FA - 0.008 * H, a: 0.0112 * H, b: 0.015 * H },
    ]
    if (d.longSleeves || look.sleeves === 'long') {
      // Long sleeve to the wrist, with a cuff.
      const k = faKeys.map(q => ({ ...q, a: q.a * 1.08 + 0.0028 * H, b: q.b * 1.08 + 0.0028 * H }))
      k[k.length - 2] = { ...k[k.length - 2]!, y: -d.FA + 0.004 * H, a: k[k.length - 2]!.a * 1.12, b: k[k.length - 2]!.b * 1.12 }
      k.pop()
      const lines = emptyLines()
      const cuffY = -d.FA + 0.03 * H
      const c = secAtY(k, cuffY)
      const ring: V3[] = []
      for (let j = 0; j < 16; j++) {
        const t = (j / 16) * PI * 2
        const r = seRadius(c.a, c.b, c.e, t) + 0.0006 * H
        ring.push([c.x + r * Math.cos(t), cuffY, c.z + r * Math.sin(t)])
      }
      polyline(lines, ring, true)
      add(fa, 'top', tube(k, 10, 2), { lines, crease: 60 })
    }
    else {
      add(fa, 'skin', tube(faKeys, 10, 2))
      if (look.sleeves === 'rolled') {
        // The sleeve rolled up in two turns just below the elbow.
        const roll: Sec[] = [
          { y: 0.012 * H, a: ra * 0.95, b: ra * 0.98 },
          { y: 0.0, a: ra * 1.1, b: ra * 1.12 },
          { y: -0.016 * H, a: ra * 1.14, b: ra * 1.16 },
          { y: -0.034 * H, a: ra * 1.08, b: ra * 1.1 },
          { y: -0.046 * H, a: ra * 0.98, b: ra * 1.0 },
        ]
        const lines = emptyLines()
        const c = secAtY(roll, -0.018 * H)
        const ring: V3[] = []
        for (let j = 0; j < 16; j++) {
          const t = (j / 16) * PI * 2
          const r = seRadius(c.a, c.b, c.e, t) + 0.0006 * H
          ring.push([c.x + r * Math.cos(t), -0.018 * H, c.z + r * Math.sin(t)])
        }
        polyline(lines, ring, true)
        add(fa, 'top', tube(roll, 10, 1), { lines, crease: 60 })
      }
    }
    // The fingers ride their own bone (curled per grip by the motion), the palm and thumb the hand's.
    const knuckle = new THREE.Matrix4().makeTranslation(side * 0.0012 * H, 0.53 * d.hand, 0)
    for (const g of handParts(d, side)) add(g.finger ? (side === 1 ? B.fiL : B.fiR) : hand, 'skin', g.geo, { lines: g.lines, crease: 60, m: g.finger ? knuckle : undefined })
  }

  // ── Neck and head ───────────────────────────────────────────────────────
  const hd = headFrame(d)
  {
    // It starts at the pivot (the neck base): below it, a bowed head would swing
    // the neck out through the back of the collar.
    const neckKeys: Sec[] = [
      { y: -0.004 * H, a: nr * 1.02, b: nr * 1.0, z: -0.001 * H },
      { y: d.neck * 0.5, a: nr, b: nr * 1.02, z: 0.0 },
      { y: d.neck + 0.02 * H, a: nr * 0.98, b: nr * 1.04, z: 0.003 * H },
      { y: d.neck + 0.05 * H, a: nr * 0.7, b: nr * 0.8, z: 0.0 },
    ]
    add(B.head, d.headscarf ? 'scarf' : 'skin', tube(neckKeys, 10, 2))
  }
  add(B.head, 'skin', tube(hd.keys, 26, 3, { disp: hd.disp }), { lines: faceLines(d, hd, look) })
  // The eyes: small dark ovals set in the sockets (vertex shade on the skin mesh: no extra draw call).
  for (const s of [1, -1]) add(B.head, 'skin', eyeGeo(d, hd, s), { crease: 0, color: () => [0.14, 0.11, 0.1] })
  add(B.head, 'skin', noseGeo(d, hd), { crease: 50 })
  if (!d.headscarf) {
    for (const s of [1, -1]) {
      const e = earGeo(d, hd, s)
      add(B.head, 'skin', e.geo, { lines: e.lines, crease: 50 })
    }
  }
  if (look.facial === 'moustache' || look.facial === 'beard') add(B.head, 'hair', moustacheGeo(d, hd), { crease: 60 })
  if (look.facial === 'beard') add(B.head, 'hair', beardGeo(d, hd))
  for (const h of hairParts(d, hd, look, torsoAt)) add(h.bone, 'hair', h.geo, { lines: h.lines, color: h.color })
  if (d.headscarf) {
    const s = hijabParts(d, hd, torsoKeys)
    for (const p of s) add(p.bone, 'scarf', p.geo, { lines: p.lines, crease: p.crease })
  }

  // ── Long garments: mundu / skirt / kurta tail ───────────────────────────
  // Each is ONE surface in the pelvis frame, weighted across the hips, both
  // thighs and both shins (rig.ts): it hangs straight when standing, follows a
  // step, lies over the lap when seated and falls from the knees -- no tiers.
  if (d.hem > 0) {
    const ring: Ring = (keys, y, l, disp, th0 = 0, th1 = 2 * PI, closed = true) => {
      const c = secAtY(keys, y)
      const pts: V3[] = []
      const n = 28
      for (let j = 0; j <= n; j++) {
        if (closed && j === n) break
        const t = th0 + (th1 - th0) * j / n
        const r = seRadius(c.a, c.b, c.e, t) + (disp ? disp(t, y) : 0) + 0.0007 * H
        pts.push([c.x + r * Math.cos(t), y, c.z + r * Math.sin(t)])
      }
      polyline(l, pts, closed)
    }
    const vline: VLine = (keys, th, y0, y1, l, disp) => {
      const pts: V3[] = []
      for (let k = 0; k <= 10; k++) {
        const y = y0 + (y1 - y0) * k / 10
        const c = secAtY(keys, y)
        const r = seRadius(c.a, c.b, c.e, th) + (disp ? disp(th, y) : 0) + 0.0007 * H
        pts.push([c.x + r * Math.cos(th), y, c.z + r * Math.sin(th)])
      }
      polyline(l, pts)
    }
    const hemY = -d.hem
    if (d.top === 'kurta' && d.lower === 'trousers') {
      const slit = -0.045 * H
      const band: Sec[] = [
        { y: d.waistY - 0.004 * H, a: wW * 0.97, b: depth * 0.95, z: 0.002 * H },
        { y: 0.012 * H, a: hipA + 0.014 * H, b: 0.068 * H * b + 0.011 * H, z: 0.001 * H },
        // Falling straight by the slit, as the panels do from it: no kink, no shading edge.
        { y: -0.02 * H, a: hipA * 1.09 + 0.014 * H, b: 0.0735 * H * b + 0.012 * H, z: 0 },
        { y: slit, a: hipA * 1.1 + 0.014 * H, b: 0.074 * H * b + 0.012 * H, z: 0 },
      ]
      add(B.pelvis, 'top', tube(band, 16, 2, { capStart: false, capEnd: false }), { rims: false, legs: true })
      // The panels hang close over the thighs (a stiff wide sheet floated over the lap when
      // seated), with a few soft folds.
      const pk: Sec[] = [
        { y: slit + 0.012 * H, a: hipA * 1.08 + 0.012 * H, b: 0.072 * H * b + 0.01 * H },
        { y: slit - 0.06 * H, a: hipA * 1.06 + 0.01 * H, b: 0.062 * H * b + 0.004 * H, z: 0.001 * H },
        { y: hemY, a: d.hemW1 * 1.02, b: 0.056 * H * b + 0.002 * H, z: 0.002 * H },
      ]
      const pfold = (th: number, y: number) => 0.003 * H * clamp((slit - y) / (slit - hemY), 0, 1) * Math.cos(9 * th + 0.4)
      // Front and back panels; in a wide stance the thighs pass out through the side slits.
      add(B.pelvis, 'top', tube(pk, 14, 3, { closed: false, th0: 0.55, th1: PI - 0.55, disp: pfold }), { rims: 'noStart', legs: true })
      add(B.pelvis, 'top', tube(pk, 14, 3, { closed: false, th0: PI + 0.42, th1: 2 * PI - 0.42, disp: pfold }), { rims: 'noStart', legs: true })
    }
    else if (d.lower === 'mundu') {
      addMundu(d, look, wW, hipA, depth, add, ring, vline)
    }
    else if (d.lower === 'skirt') {
      // A long A-line skirt: waistband (a tee tucked into it), gently flared,
      // soft folds that deepen toward the hem.
      // The waistband reaches well up over the tucked tee, so no gap opens between them
      // when the body bends or sits.
      const tw = secAtY(torsoKeys, 0.04 * H)
      const keys: Sec[] = [
        { y: d.waistY + 0.042 * H, a: tw.a + 0.006 * H, b: tw.b + 0.006 * H, z: tw.z },
        { y: d.waistY, a: wW + 0.006 * H, b: depth + 0.006 * H, z: 0.002 * H },
        { y: 0.0, a: hipA * 1.06, b: 0.074 * H * b, z: 0 },
        { y: -0.06 * H, a: hipA * 1.12, b: 0.08 * H * b, z: 0.002 * H },
        { y: hemY * 0.55, a: d.hemW0 + (d.hemW1 - d.hemW0) * 0.55, b: 0.084 * H * b, z: 0.004 * H },
        { y: hemY, a: d.hemW1, b: 0.09 * H * b, z: 0.005 * H },
      ]
      const fold = (th: number, y: number) => {
        const u = clamp((d.waistY - y) / (d.waistY - hemY), 0, 1)
        return 0.008 * H * u * u * Math.cos(7 * th + 0.6) + 0.003 * H * u * Math.cos(13 * th + 1.3)
      }
      const l = emptyLines()
      ring(keys, d.waistY + 0.012 * H, l)
      // A few fold crests drawn on the front and sides.
      for (const k of [1, 2, 3, 5]) {
        const th = (2 * PI * k - 0.6) / 7
        vline(keys, th, -0.03 * H, hemY + 0.004 * H, l, fold)
      }
      add(B.pelvis, 'bottom', tube(keys, 30, 3, { capStart: false, disp: fold }), { lines: l, legs: true })
    }
  }

  // ── Apron ───────────────────────────────────────────────────────────────
  if (look.apron) {
    const bibTop = 0.8 * L
    const bib = shell((th, y) => torsoAt(th, y, 0.009 * H), () => bibTop, () => hemY + 0.004 * H, 10, 6, { closed: false, th0: PI / 2 - 0.72, th1: PI / 2 + 0.72 })
    const lines = emptyLines()
    // Neck strap over the shoulders and the waist ties round the back.
    for (const s of [1, -1]) {
      const c = torsoAt(PI / 2 - s * 0.72, bibTop, 0.009 * H)
      polyline(lines, [c, [s * 0.035 * H, L + 0.004 * H, 0.012 * H], [s * 0.03 * H, L + 0.012 * H, -0.012 * H], [0, L + 0.008 * H, -0.03 * H]])
    }
    const tie: V3[] = []
    for (let k = 0; k <= 10; k++) tie.push(torsoAt(PI / 2 + 0.72 + (2 * PI - 1.44) * k / 10, 0.01 * H, 0.004 * H))
    polyline(lines, tie)
    add(B.spine, 'scarf', bib, { lines })
    const skirtK: Sec[] = [
      { y: d.waistY - 0.03 * H, a: hipA * 1.0 + 0.014 * H, b: 0.07 * H * b + 0.014 * H, z: 0.003 * H },
      { y: -0.04 * H, a: hipA * 1.14 + 0.012 * H, b: 0.084 * H * b + 0.01 * H, z: 0.004 * H },
      { y: -0.92 * d.L1, a: hipA * 1.12, b: 0.082 * H * b, z: 0.008 * H },
    ]
    const al = emptyLines()
    const pk: V3[] = []
    for (const [u, v] of [[0.35, -0.12], [0.35, -0.24], [-0.35, -0.24], [-0.35, -0.12]] as const) pk.push(surfPoint(skirtK, PI / 2 + u, v * H, 0.0008 * H))
    polyline(al, pk, true)
    add(B.pelvis, 'scarf', tube(skirtK, 10, 2, { closed: false, th0: PI / 2 - 0.95, th1: PI / 2 + 0.95 }), { lines: al, legs: true })
  }
  return parts
}

// ── Mundu / lungi ─────────────────────────────────────────────────────────

type Ring = (keys: Sec[], y: number, l: LineData, disp?: (th: number, y: number) => number, th0?: number, th1?: number, closed?: boolean) => void
type VLine = (keys: Sec[], th: number, y0: number, y1: number, l: LineData, disp?: (th: number, y: number) => number) => void

/**
 * A mundu (white, with the kasavu's gold border at the hem and along the
 * front overlap) or a lungi (dyed, a woven check). Knotted at the waist under
 * the shirt, hanging straight to the ankle; or hitched up and tucked to the
 * knee (madakki kuthu), the doubled hem rolled.
 */
function addMundu(d: Dims, look: Look, wW: number, hipA: number, depth: number, add: (bone: number, role: Role, geo: THREE.BufferGeometry, o?: AddOpts) => void, ring: Ring, vline: VLine) {
  const H = d.H, b = d.build
  const top = d.waistY - 0.004 * H
  const hem = look.folded ? -0.86 * d.L1 : -d.hem
  const keys: Sec[] = [
    // Up under the shirt the cloth stays well inside it (the knot never shows through the shirt).
    { y: top, a: wW * 0.94, b: depth * 0.9, z: 0.0 },
    { y: 0.02 * H, a: hipA * 0.98, b: 0.066 * H * b, z: 0.0 },
    { y: -0.04 * H, a: hipA * 1.1, b: 0.074 * H * b, z: 0.002 * H },
    { y: hem * 0.5, a: 0.102 * H * b, b: 0.07 * H * b, z: 0.005 * H },
    ...(look.folded
      ? [
          { y: hem + 0.02 * H, a: 0.104 * H * b, b: 0.072 * H * b, z: 0.006 * H },
          { y: hem + 0.0155 * H, a: 0.106 * H * b, b: 0.0735 * H * b, z: 0.006 * H },
          { y: hem + 0.0135 * H, a: 0.1065 * H * b, b: 0.074 * H * b, z: 0.006 * H },
          { y: hem + 0.008 * H, a: 0.108 * H * b, b: 0.075 * H * b, z: 0.006 * H },
          { y: hem, a: 0.105 * H * b, b: 0.073 * H * b, z: 0.006 * H },
        ]
      : [
          { y: hem + 0.032 * H, a: d.hemW1 * 1.05, b: 0.0715 * H * b, z: 0.007 * H },
          { y: hem + 0.029 * H, a: d.hemW1 * 1.051, b: 0.0716 * H * b, z: 0.007 * H },
          { y: hem, a: d.hemW1 * 1.06, b: 0.072 * H * b, z: 0.007 * H },
        ]),
  ]
  // The front overlap: the outer layer's edge stands a hair proud of the cloth beneath.
  const edgeTh = Math.PI / 2 - 0.32
  const lap = (th: number, _y: number) => {
    const dth = Math.atan2(Math.sin(th - edgeTh), Math.cos(th - edgeTh))
    return dth > 0 && dth < 1.4 ? 0.003 * H * (1 - dth / 1.4) : 0
  }
  const l = emptyLines()
  vline(keys, edgeTh, -0.03 * H, hem, l, lap)
  // Two soft folds falling from the knot.
  for (const th of [Math.PI / 2 + 0.25, Math.PI / 2 - 0.85]) vline(keys, th, -0.02 * H, hem * 0.7, l, lap)
  if (look.folded) ring(keys, hem + 0.012 * H, l, lap)
  if (look.lungi) for (const f of [0.3, 0.55, 0.8]) ring(keys, hem * f, l, lap)
  const band = look.folded ? 0.014 * H : 0.03 * H
  if (!look.lungi) vline(keys, edgeTh - 0.07, -0.03 * H, hem, l, lap)
  const gold: [number, number, number] = [0.86, 0.72, 0.38]
  const color = (p: V3): [number, number, number] => {
    // A lungi: a darker woven band above the hem (its stripes are drawn as lines).
    if (look.lungi) return p[1] < hem + band ? [0.78, 0.78, 0.78] : [1, 1, 1]
    return p[1] < hem + band ? gold : [1, 1, 1]
  }
  add(B.pelvis, 'bottom', tube(keys, 30, 3, { capStart: false, disp: lap }), { lines: l, legs: true, color })
}

// ── Head ──────────────────────────────────────────────────────────────────

interface HeadFrame {
  keys: Sec[]
  cy: number
  hh: number
  W: number
  D: number
  cz: number
  /** Relief over the base head (radial offset): brow ridge, eye sockets, cheekbones, jaw, chin. */
  disp: (th: number, y: number) => number
}

function headFrame(d: Dims): HeadFrame {
  const H = d.H
  const hh = d.headH
  const W = d.headW / 2
  const D = d.headD / 2
  const cy = d.neck + hh * 0.5
  const cz = 0.01 * H
  const kid = d.variant === 'child'
  // (fy, width, depth, z) as fractions of the head: chin, jaw, cheeks, temples, cranium, crown.
  const table: [number, number, number, number][] = kid
    ? [[-0.5, 0.26, 0.22, 0.36], [-0.45, 0.52, 0.44, 0.24], [-0.34, 0.8, 0.74, 0.1], [-0.18, 0.93, 0.9, 0.03], [0.02, 1, 0.98, -0.02], [0.2, 1.02, 1, -0.04], [0.36, 0.95, 0.94, -0.05], [0.46, 0.7, 0.72, -0.06], [0.51, 0.2, 0.22, -0.05]]
    : [[-0.5, 0.2, 0.18, 0.42], [-0.46, 0.42, 0.36, 0.3], [-0.36, 0.72, 0.66, 0.14], [-0.2, 0.89, 0.86, 0.04], [0.0, 0.97, 0.97, -0.02], [0.18, 1, 1, -0.04], [0.34, 0.93, 0.94, -0.06], [0.45, 0.68, 0.7, -0.07], [0.505, 0.2, 0.22, -0.06]]
  const keys = table.map(([fy, fa, fb, fz]) => ({ y: cy + fy * hh, a: fa * W, b: fb * D, z: cz + fz * D, e: 2.3 }))
  // A little form in the face, drawn in planes rather than features: a brow
  // ridge over shallow eye sockets, cheekbones, the angle of the jaw, the chin.
  const g = (x: number) => Math.exp(-x * x)
  const k = kid ? 0.6 : 1
  const disp = (th: number, y: number) => {
    const fy = (y - cy) / hh
    const u = Math.cos(th)
    const front = Math.max(0, Math.sin(th)) ** 2
    const au = Math.abs(u)
    return hh * k * (
      0.016 * front * g((fy - 0.11) / 0.035) * g(u / 0.55)
      - 0.012 * front * g((fy - 0.035) / 0.05) * g((au - 0.4) / 0.14)
      + 0.011 * g((fy + 0.07) / 0.06) * g((au - 0.62) / 0.15)
      + 0.012 * g((fy + 0.33) / 0.06) * g((au - 0.86) / 0.12)
      + 0.016 * front * g((fy + 0.43) / 0.05) * g(u / 0.25)
      + 0.006 * front * g((fy + 0.24) / 0.06) * g(u / 0.35)
    )
  }
  return { keys, cy, hh, W, D, cz, disp }
}

/** Point on the face at x (absolute) and height y, pushed out by `out`. */
function onFace(hd: HeadFrame, x: number, y: number, out: number): V3 {
  const s = secAtY(hd.keys, y)
  // The polar angle that lands near x on the front of the head, then the relief and the offset along it.
  let th = Math.PI / 2
  for (let it = 0; it < 4; it++) {
    const r = seRadius(s.a, s.b, s.e, th) + hd.disp(th, y)
    const c = Math.max(-0.999, Math.min(0.999, (x - s.x) / r))
    th = Math.acos(c)
  }
  const r = seRadius(s.a, s.b, s.e, th) + hd.disp(th, y) + out
  return [s.x + r * Math.cos(th), y, s.z + r * Math.sin(th)]
}

/** A small dark oval eye, a hair proud of the socket. */
function eyeGeo(d: Dims, hd: HeadFrame, s: number) {
  const W = hd.W, hh = hd.hh
  const ex = s * W * 0.4, ey = hd.cy + hh * 0.03
  const ring = (k: number, out: number): V3[] => {
    const r: V3[] = []
    for (let j = 0; j < 10; j++) {
      const t = (j / 10) * Math.PI * 2
      r.push(onFace(hd, ex + W * 0.085 * k * Math.cos(t), ey + hh * 0.03 * k * Math.sin(t), out))
    }
    return r
  }
  return surface([ring(1, 0.0004 * d.H), ring(0.96, 0.0016 * d.H), ring(0.55, 0.0024 * d.H)])
}

function faceLines(d: Dims, hd: HeadFrame, look: Look): LineData {
  const H = d.H, W = hd.W, hh = hd.hh, cy = hd.cy
  const l = emptyLines()
  const o = 0.0012 * H
  for (const s of [1, -1]) {
    // Brow: a soft arch, drawn twice a hair apart so it reads as a brow, not a crease.
    for (const dy of [0, 0.012 * hh]) {
      const pts: V3[] = []
      for (let k = 0; k <= 5; k++) {
        const u = k / 5
        pts.push(onFace(hd, s * W * (0.16 + 0.46 * u), cy + hh * (0.115 + 0.03 * Math.sin(Math.PI * (0.3 + 0.7 * u)) - 0.02 * u) - dy, o))
      }
      polyline(l, pts)
    }
    // Eye: a small almond (it reads as a dark eye at a distance, an eye up close).
    const ex = s * W * 0.4, ey = cy + hh * 0.03
    // Upper lid crease above it.
    const lid: V3[] = []
    for (let k = 0; k <= 4; k++) {
      const u = k / 4
      lid.push(onFace(hd, ex + W * (-0.13 + 0.26 * u), ey + hh * (0.042 + 0.012 * Math.sin(Math.PI * u)), o))
    }
    polyline(l, lid)
  }
  if (look.facial !== 'beard') {
    // Mouth: a short line with the faintest lift at the corners.
    const pts: V3[] = []
    for (let k = 0; k <= 6; k++) {
      const u = k / 3 - 1
      pts.push(onFace(hd, W * 0.2 * u, cy - hh * (0.285 - 0.012 * u * u), o))
    }
    polyline(l, pts)
  }
  if (look.glasses) {
    // Thin round-cornered frames in front of the eyes, a bridge, and temples back to the ears.
    const ly = cy + hh * 0.025
    const lw = W * 0.26, lhh = hh * 0.07
    for (const s of [1, -1]) {
      const cx = s * W * 0.41
      const loop: V3[] = []
      for (let k = 0; k < 16; k++) {
        const t = (k / 16) * Math.PI * 2
        const c = Math.cos(t), sn = Math.sin(t)
        const px = cx + lw * Math.sign(c) * Math.pow(Math.abs(c), 0.6)
        const py = ly + lhh * Math.sign(sn) * Math.pow(Math.abs(sn), 0.6)
        loop.push(onFace(hd, px, py, 0.008 * H))
      }
      polyline(l, loop, true)
      const temple: V3[] = []
      for (let k = 0; k <= 6; k++) {
        const th = Math.PI / 2 - s * (Math.PI / 2) * (0.62 + 0.45 * k / 6)
        const p = surfPoint(hd.keys, s > 0 ? th : th, ly + hh * 0.01 * k / 6, 0.006 * H)
        temple.push(p)
      }
      temple[0] = onFace(hd, cx + s * lw, ly, 0.008 * H)
      polyline(l, temple)
    }
    polyline(l, [onFace(hd, W * 0.15, ly + lhh * 0.3, 0.009 * H), onFace(hd, 0, ly + lhh * 0.45, 0.012 * H), onFace(hd, -W * 0.15, ly + lhh * 0.3, 0.009 * H)])
  }
  return l
}

function noseGeo(d: Dims, hd: HeadFrame) {
  const hh = hd.hh, W = hd.W, cy = hd.cy
  const k = d.variant === 'child' ? 0.7 : 1
  // (fy, protrusion, half-width) as fractions of the head.
  const t: [number, number, number][] = [[0.1, -0.01, 0.07], [0.05, 0.012, 0.075], [-0.03, 0.036, 0.085], [-0.1, 0.058, 0.11], [-0.135, 0.064, 0.16], [-0.16, 0.04, 0.18]]
  const keys: Sec[] = t.map(([fy, p, a]) => {
    const y = cy + fy * hh
    const face = onFace(hd, 0, y, 0)[2]
    const pr = p * hh * k
    const bb = 0.55 * pr + 0.012 * hh
    return { y, a: a * W * (0.85 + 0.15 * k), b: bb, z: face + pr - bb, e: 2 }
  })
  return tube(keys, 8, 1)
}

function earGeo(d: Dims, hd: HeadFrame, s: number) {
  const H = d.H, hh = hd.hh
  const yc = hd.cy - 0.02 * hh
  const zc = hd.cz - 0.12 * hd.D
  const surf = surfPoint(hd.keys, s > 0 ? -0.12 : Math.PI + 0.12, yc)
  const x0 = surf[0] - s * 0.004 * H, x1 = surf[0] + s * 0.008 * H
  const ry = 0.13 * hh, rz = 0.075 * hh
  const ring = (x: number, k: number, tilt: number): V3[] => {
    const r: V3[] = []
    for (let j = 0; j < 14; j++) {
      const t = (j / 14) * Math.PI * 2
      const yy = Math.sin(t) * ry * k * (Math.sin(t) > 0 ? 1 : 0.85)
      r.push([x, yc + yy, zc + Math.cos(t) * rz * k - yy * tilt])
    }
    return r
  }
  const geo = surface([ring(x0, 0.95, 0.15), ring(x1, 1, 0.15), ring(x1 + s * 0.0015 * H, 0.82, 0.15)])
  const lines = emptyLines()
  // The fold of the ear (helix), inside the rim.
  const inner = ring(x1 + s * 0.0022 * H, 0.55, 0.15).slice(3, 13)
  polyline(lines, inner)
  return { geo, lines }
}

function moustacheGeo(d: Dims, hd: HeadFrame) {
  const H = d.H, W = hd.W, hh = hd.hh
  const rings: V3[][] = []
  const n = 9
  for (let i = 0; i <= n; i++) {
    const u = (i / n) * 2 - 1
    const x = u * W * 0.3
    const yc = hd.cy - hh * (0.205 + 0.03 * u * u)
    const surf = onFace(hd, x, yc, 0)
    const ry = 0.024 * hh * (1 - 0.55 * u * u)
    const rz = 0.009 * H * (1 - 0.5 * u * u)
    const r: V3[] = []
    for (let j = 0; j < 8; j++) {
      const t = (j / 8) * Math.PI * 2
      r.push([x, yc + Math.sin(t) * ry, surf[2] - 0.003 * H + Math.cos(t) * rz])
    }
    rings.push(r)
  }
  return surface(rings)
}

function beardGeo(d: Dims, hd: HeadFrame) {
  const H = d.H, hh = hd.hh, cy = hd.cy
  const top = angleTable([[90, -0.245], [55, -0.2], [30, -0.05], [12, 0.02], [0, -0.05], [-25, -0.2]])
  const bottom = (_th: number) => cy - 0.5 * hh
  return shell((th, y) => {
    const yy = Math.max(y, cy - 0.49 * hh)
    const p = surfPoint(hd.keys, th, yy, 0.012 * H * (0.6 + 0.4 * Math.max(0, Math.sin(th))))
    if (y < yy) p[1] = y
    return p
  }, th => cy + top(th) * hh, bottom, 20, 6, { closed: false, th0: -0.45, th1: Math.PI + 0.45 })
}

// ── Hair ──────────────────────────────────────────────────────────────────

function hairParts(d: Dims, hd: HeadFrame, look: Look, torsoAt: (th: number, y: number, out?: number) => V3) {
  const H = d.H, hh = hd.hh, cy = hd.cy
  const out: { bone: number, geo: THREE.BufferGeometry, lines?: LineData, color?: (p: V3) => [number, number, number] }[] = []
  const style = look.hair
  if (style === 'none') return out
  // Hem height (fraction of the head) by angle: 90 = front, 0 = the side, -90 = the back.
  const hems: Record<string, [number, number][]> = {
    // (A hairline, not a cap's edge: a little lower in the middle, up at the temples.)
    short: [[90, 0.3], [70, 0.335], [52, 0.285], [32, 0.16], [18, -0.06], [8, 0.11], [-10, 0.1], [-35, -0.16], [-90, -0.36]],
    side: [[90, 0.285], [70, 0.325], [52, 0.27], [32, 0.15], [18, -0.07], [8, 0.11], [-10, 0.1], [-35, -0.16], [-90, -0.38]],
    curly: [[90, 0.29], [70, 0.31], [52, 0.25], [32, 0.12], [18, -0.04], [8, 0.1], [-10, 0.08], [-35, -0.18], [-90, -0.38]],
    receding: [[90, 0.44], [50, 0.38], [30, 0.2], [18, 0.0], [8, 0.11], [-10, 0.1], [-35, -0.14], [-90, -0.34]],
    bun: [[90, 0.34], [50, 0.29], [32, 0.12], [15, 0.0], [0, -0.02], [-30, -0.22], [-90, -0.4]],
    plait: [[90, 0.34], [50, 0.29], [32, 0.12], [15, 0.0], [0, -0.02], [-30, -0.22], [-90, -0.42]],
    ponytail: [[90, 0.3], [50, 0.25], [32, 0.1], [15, -0.02], [0, -0.04], [-30, -0.22], [-90, -0.4]],
    long: [[90, 0.33], [52, 0.26], [40, -0.5], [20, -0.85], [0, -0.95], [-90, -1.05]],
  }
  const hemBase = angleTable(hems[style]!)
  // A natural hairline: the fringe is not a ruler-straight cap edge but steps
  // in small locks across the forehead, and recedes a little at the temples.
  const hem = (th: number) => {
    const front = Math.max(0, Math.sin(th))
    const locks = style === 'receding' || style === 'bun' || style === 'plait'
      ? 0
      : (0.014 * Math.sin(11 * th + 0.7) + 0.008 * Math.sin(23 * th + 1.9)) * front ** 2
    return hemBase(th) + locks
  }
  // The hair is the head itself inflated: every section grows by the hair's
  // thickness (more on top) and the crown rises by it, so the scalp can never
  // show through and the shell always clears the head.
  // (Thick enough to read as hair rather than a painted scalp: more on top than at the sides.)
  const base = style === 'curly' ? [0.07, 0.14] : style === 'receding' ? [0.022, 0.018] : style === 'long' ? [0.04, 0.09] : style === 'side' ? [0.036, 0.115] : style === 'short' ? [0.034, 0.1] : [0.032, 0.08]
  const tSide = base[0]! * hh, tTop = base[1]! * hh
  const hk: Sec[] = hd.keys.map((k) => {
    const up = clamp((k.y - cy) / (0.5 * hh), 0, 1)
    const t = tSide + (tTop - tSide) * up
    return { ...k, y: k.y + up * tTop * 0.9, a: k.a + t, b: k.b + t }
  })
  const crown = hk[hk.length - 1]!.y
  const bottomY = hk[0]!.y
  // Long hair falls past the jaw; below the head it follows a wider fall line instead of the chin.
  const fallKeys: Sec[] = [
    { y: cy - 0.2 * hh, a: hd.W * 0.98 + tSide, b: hd.D * 0.92 + tSide, z: hd.cz - 0.06 * hd.D },
    { y: cy - 0.6 * hh, a: hd.W * 1.0 + tSide, b: hd.D * 0.72, z: hd.cz - 0.2 * hd.D },
    { y: cy - 1.1 * hh, a: hd.W * 1.05, b: hd.D * 0.55, z: hd.cz - 0.32 * hd.D },
  ]
  const pt = (th: number, y: number): V3 => {
    if (style === 'long' && y < cy - 0.2 * hh) return surfPoint(fallKeys, th, Math.max(y, cy - 1.1 * hh))
    const yy = clamp(y, bottomY, crown)
    let extra = 0
    const up = clamp((yy - cy) / (0.5 * hh), 0, 1)
    // A side part: a little more volume over the brow on one side.
    if (style === 'side') extra += 0.024 * hh * Math.max(0, Math.cos(th - 1.25)) * up
    if (style === 'curly') extra += 0.016 * hh * Math.cos(9 * th) * Math.cos(16 * (yy - cy) / hh)
    else if (style !== 'receding') {
      // Volume at the crown and the back, and the hair lying in a few soft clumps that
      // sweep back from the front (combed, not moulded).
      extra += 0.014 * hh * up * Math.max(0, -Math.sin(th))
      extra += 0.006 * hh * up * Math.cos(7 * th + 2.4 * (yy - cy) / hh)
    }
    const p = surfPoint(hk, th, yy, extra)
    if (y < yy) p[1] = y
    return p
  }
  const topFn = style === 'receding'
    ? angleTable([[90, 0.47], [30, 0.4], [0, 0.36], [-90, 0.3]])
    : () => (crown - cy) / hh
  const lines = emptyLines()
  // Flow lines: a few strands combed from the crown (or the part) toward the hem.
  if (style !== 'curly') {
    const flows = style === 'receding' ? [] : Array.from({ length: 17 }, (_, i) => 0.2 + i * 0.37 + 0.08 * Math.sin(i * 2.3))
    for (const [i, th0] of flows.entries()) {
      const pts: V3[] = []
      const t0 = i % 3 === 0 ? 0 : i % 3 === 1 ? 0.15 : 0.3
      for (let k = 1; k <= 6; k++) {
        const t = t0 + (1 - t0) * k / 7
        const th = th0 + (style === 'side' ? 0.5 : 0.25) * t
        const yTop = crown, yHem = cy + hem(th) * hh
        const y = yTop + (yHem - yTop) * (0.08 + 0.82 * t)
        const p = pt(th, y)
        const c = secAtY(hk, Math.max(bottomY, Math.min(crown, y)))
        const dx = p[0] - c.x, dz = p[2] - c.z
        const dl = Math.hypot(dx, dz) || 1
        pts.push([p[0] + dx / dl * 0.0008 * H, p[1], p[2] + dz / dl * 0.0008 * H])
      }
      polyline(lines, pts)
    }
  }
  // Short strands at the hairline (fringe and temples), falling to the edge.
  if (style !== 'receding' && style !== 'bun' && style !== 'plait') {
    for (let k = 0; k <= 16; k++) {
      const th = 0.35 + (PI - 0.7) * k / 16 + 0.05 * Math.sin(k * 3.7)
      const yh = cy + hem(th) * hh
      polyline(lines, [pt(th - 0.04, yh + 0.07 * hh), pt(th - 0.015, yh + 0.035 * hh), pt(th, yh + 0.006 * hh)].map(p => {
        const c = secAtY(hk, clamp(p[1], bottomY, crown))
        const dx = p[0] - c.x, dz = p[2] - c.z
        const dl = Math.hypot(dx, dz) || 1
        return [p[0] + dx / dl * 0.0008 * H, p[1], p[2] + dz / dl * 0.0008 * H] as V3
      }))
    }
  }
  if (style === 'side') {
    const pts: V3[] = []
    for (let k = 0; k <= 6; k++) {
      const y = cy + hh * (0.3 + 0.18 * k / 6)
      const th = Math.PI / 2 - 0.55 + 0.25 * k / 6
      pts.push(pt(th, y))
    }
    polyline(lines, pts)
  }
  // A soft sheen across the top (light on dark hair) and a darker edge at the hairline.
  const sheenY = cy + 0.34 * hh
  const color = (p: V3): [number, number, number] => {
    const c = secAtY(hk, clamp(p[1], bottomY, crown))
    const th = Math.atan2(p[2] - c.z, p[0] - c.x)
    const k = 1 + 0.8 * Math.exp(-(((p[1] - sheenY) / (0.07 * hh)) ** 2)) * (0.4 + 0.6 * Math.max(0, Math.sin(th))) - 0.12 * clamp((cy + hem(th) * hh + 0.05 * hh - p[1]) / (0.05 * hh), 0, 1)
    return [k, k, k]
  }
  out.push({
    bone: B.head,
    geo: shell(pt, th => cy + topFn(th) * hh, th => cy + hem(th) * hh, style === 'curly' ? 32 : 30, style === 'long' ? 12 : 9, { capStart: style !== 'receding', capEnd: false }),
    lines,
    color,
  })
  if (style === 'bun') {
    const r = 0.17 * hh
    const c: V3 = [0, cy + 0.14 * hh, hd.cz - hd.D - 0.06 * hh]
    const keys: Sec[] = []
    for (let k = 0; k <= 6; k++) {
      const a = -Math.PI / 2 + Math.PI * k / 6
      const rr = Math.max(0.15 * r, r * Math.cos(a))
      keys.push({ y: c[1] + r * Math.sin(a), a: rr, b: rr * 0.9, z: c[2], e: 2 })
    }
    out.push({ bone: B.head, geo: tube(keys, 16, 2) })
  }
  if (style === 'ponytail') {
    const zb = hd.cz - hd.D
    const keys: Sec[] = [
      { y: cy + 0.16 * hh, a: 0.07 * hh, b: 0.07 * hh, z: zb - 0.02 * hh },
      { y: cy + 0.05 * hh, a: 0.1 * hh, b: 0.09 * hh, z: zb - 0.08 * hh },
      { y: cy - 0.25 * hh, a: 0.08 * hh, b: 0.07 * hh, z: zb - 0.07 * hh },
      { y: cy - 0.5 * hh, a: 0.03 * hh, b: 0.03 * hh, z: zb - 0.03 * hh },
    ]
    out.push({ bone: B.head, geo: tube(keys, 10, 2) })
  }
  if (style === 'plait') {
    // A plait down the back, on the spine so it lies on the back however the head turns.
    const L = d.spineLen
    const y0 = L + d.neck + 0.12 * hh, y1 = L - 0.2 * H
    const keys: Sec[] = []
    const n = 9
    for (let k = 0; k <= n; k++) {
      const y = y0 + (y1 - y0) * k / n
      const back = y < L ? torsoAt(-Math.PI / 2, y, 0)[2] : -0.03 * H
      const bead = k % 2 === 0 ? 1 : 0.72
      const r = (0.016 - 0.007 * k / n) * H * bead
      keys.push({ y, a: r, b: r * 0.8, z: back - 0.01 * H, e: 2 })
    }
    out.push({ bone: B.spine, geo: tube(keys, 10, 2) })
  }
  return out
}

function hijabParts(d: Dims, hd: HeadFrame, torsoKeys: Sec[]) {
  const H = d.H, hh = hd.hh, cy = hd.cy, L = d.spineLen
  const out: { bone: number, geo: THREE.BufferGeometry, lines?: LineData, crease?: number }[] = []
  const chinY = cy - 0.42 * hh
  const collar = 0.07 * H * d.build
  const ym = cy - 0.06 * hh, ry = 0.43 * hh, rth = 0.98
  const faceMask = (th: number, y: number) => {
    const dth = Math.atan2(Math.sin(th - Math.PI / 2), Math.cos(th - Math.PI / 2))
    const q = Math.hypot(dth / rth, (y - ym) / ry)
    return 1 - sstep(0.86, 1.06, q)
  }
  const outT = 0.007 * H
  const sk: Sec[] = hd.keys.map((k) => {
    const up = clamp((k.y - cy) / (0.5 * hh), 0, 1)
    const t = outT + 0.012 * hh * up
    return { ...k, y: k.y + up * t * 0.9, a: k.a + t, b: k.b + t }
  })
  const pt = (th: number, y: number): V3 => {
    if (y >= chinY) {
      // Over the head the cloth is the head inflated (the crown rises with it).
      const m = faceMask(th, y)
      const yy = Math.min(y, sk[sk.length - 1]!.y)
      const so = secAtY(sk, yy)
      const ro = seRadius(so.a, so.b, so.e, th)
      if (m < 1e-3) return [so.x + ro * Math.cos(th), y, so.z + ro * Math.sin(th)]
      const si = secAtY(hd.keys, Math.min(y, cy + 0.5 * hh))
      const ri = seRadius(si.a, si.b, si.e, th) * 0.8
      const r = ro * (1 - m) + ri * m
      const z = so.z * (1 - m) + si.z * m
      return [so.x + r * Math.cos(th), y, z + r * Math.sin(th)]
    }
    // Under the chin the cloth widens to a round collar over the neck base.
    const s = secAtY(hd.keys, chinY)
    const r0 = seRadius(s.a, s.b, s.e, th) + outT
    const u = sstep(chinY, -0.03 * H, y)
    const r = r0 + (collar * 1.06 - r0) * u
    const z = s.z * (1 - u)
    return [r * Math.cos(th), y, z + r * Math.sin(th)]
  }
  const lines = emptyLines()
  const oval: V3[] = []
  for (let k = 0; k < 24; k++) {
    const p = (k / 24) * Math.PI * 2
    const th = Math.PI / 2 + rth * 0.95 * Math.cos(p)
    const y = ym + ry * 0.95 * Math.sin(p)
    oval.push(surfPoint(hd.keys, th, y, 0.003 * H))
  }
  polyline(lines, oval, true)
  out.push({ bone: B.head, geo: shell(pt, () => sk[sk.length - 1]!.y, () => -0.03 * H, 28, 12, { capEnd: false }), lines, crease: 75 })
  // Drape over the shoulders and the chest, on the spine.
  const drapeKeys = torsoKeys
  // (Its top tucks up under the hood's collar, so no ring of the tunic shows between them.)
  const dtop = L + 0.016 * H
  // The drape: cloth falling from the collar over the shoulders, never inside the body;
  // out over the tops of the sleeves (they used to poke through it), in soft folds that
  // deepen toward its hem.
  const shoulderOut = d.shoulderX + 0.026 * H * Math.sqrt(d.build) + 0.007 * H
  const dhem = angleTable([[90, 0.5], [55, 0.63], [30, 0.8], [12, 0.88], [0, 0.9], [-12, 0.88], [-35, 0.76], [-90, 0.64]])
  const dpt = (th: number, y: number): V3 => {
    const yy = Math.max(y, torsoKeys[0]!.y)
    const s = secAtY(drapeKeys, Math.min(yy, L + 0.012 * H))
    const c2 = Math.cos(th) ** 2
    // Over the shoulder joint the cloth rides on the arm's top, not the torso's.
    const overArm = c2 ** 2 * sstep(L, d.shoulderY + 0.01 * H, y) * (1 - sstep(d.shoulderY - 0.005 * H, d.shoulderY - 0.035 * H, y))
    const body = seRadius(s.a, s.b, s.e, th) + 0.011 * H + 0.006 * H * c2
    const rb = Math.max(body, body + (shoulderOut - body) * overArm)
    const rc = collar * 0.72 + (dtop - y) * 0.55
    const u = clamp((dtop - y) / (dtop - dhem(th) * L), 0, 1)
    const fold = 0.004 * H * u * u * Math.cos(7 * th + 0.5)
    const r = Math.max(rb, rc) + fold
    const z = rb >= rc ? s.z : 0
    return [r * Math.cos(th), y, z + r * Math.sin(th)]
  }
  const dl = emptyLines()
  for (const th of [Math.PI / 2 - 0.3, Math.PI / 2 + 0.45]) {
    const pts: V3[] = []
    const yb = dhem(th) * L + 0.01 * H
    for (let k = 0; k <= 5; k++) pts.push(dpt(th, dtop - 0.004 * H - (dtop - yb) * k / 5).map((v, i) => (i === 1 ? v : v * 1.004)) as V3)
    polyline(dl, pts)
  }
  out.push({ bone: B.spine, geo: shell(dpt, () => dtop, th => dhem(th) * L, 32, 8, { capStart: false, capEnd: false }), lines: dl })
  return out
}

// ── Hands ─────────────────────────────────────────────────────────────────

function handParts(d: Dims, side: number) {
  const H = d.H, Lh = d.hand
  const s = side
  // Palm: thickness along X (the palm faces -side * X), width along Z, thumb
  // toward +Z. Four fingers and a thumb, each a tube swept along a curl toward
  // the palm: hanging, the hand is relaxed; on a handle (palm on the grip) the
  // fingers wrap round it and the thumb closes over the other side.
  // (Rounded, not a box: it reads as a hand at a distance.)
  const palm: Sec[] = [
    { y: 0.008 * H, a: 0.0102 * H, b: 0.0152 * H },
    { y: -0.18 * Lh, a: 0.0108 * H, b: 0.0194 * H, z: 0.0008 * H },
    { y: -0.42 * Lh, a: 0.0098 * H, b: 0.0208 * H, z: 0.0004 * H },
    { y: -0.56 * Lh, a: 0.0084 * H, b: 0.0202 * H, x: -s * 0.0012 * H },
  ].map(k => ({ ...k, e: 2.2 }))
  const out: { geo: THREE.BufferGeometry, lines?: LineData, finger?: boolean }[] = [{ geo: tube(palm, 12, 1) }]
  // Index (toward the thumb) to little finger: z position, length, thickness (close
  // together, full: a hand, not a bunch of sticks).
  const fingers: [number, number, number][] = [[0.0145, 0.42, 0.0058], [0.0049, 0.46, 0.006], [-0.0047, 0.43, 0.0056], [-0.0137, 0.34, 0.005]]
  for (const [fz, fl, fr] of fingers) {
    const path: V3[] = []
    const radii: [number, number][] = []
    const n = 4
    let x = -s * 0.0012 * H, y = -0.53 * Lh
    const segL = (fl * Lh) / n
    for (let k = 0; k <= n; k++) {
      path.push([x, y, fz * H])
      const taper = 1 - 0.28 * k / n
      radii.push([fr * H * taper * 0.92, fr * H * taper])
      // Curl grows toward the tip: about 75 degrees in all.
      // A light curl of their own; the finger bone adds the grip's curl at the knuckle.
      const phi = 0.6 * ((k + 0.5) / n)
      x += -s * Math.sin(phi) * segL
      y += -Math.cos(phi) * segL
    }
    radii[n] = [radii[n]![0] * 0.6, radii[n]![1] * 0.6]
    out.push({ geo: sweep(path, radii, 6), finger: true })
  }
  // Thumb: from the heel of the palm, out and down, closing toward the palm.
  {
    const path: V3[] = []
    const radii: [number, number][] = []
    const n = 4
    for (let k = 0; k <= n; k++) {
      const u = k / n
      // (Lying along the side of the index finger, not sticking out from the hand.)
      path.push([
        -s * (0.003 + 0.012 * u * u) * H,
        (-0.1 - 0.38 * u) * Lh,
        (0.013 + 0.016 * Math.sin(u * 1.8)) * H,
      ])
      const r = (0.0078 - 0.0028 * u) * H
      radii.push([r, r * 0.92])
    }
    radii[n] = [radii[n]![0] * 0.6, radii[n]![1] * 0.6]
    out.push({ geo: sweep(path, radii, 6, [1, 0, 0]) })
  }
  return out
}

// ── Feet ──────────────────────────────────────────────────────────────────

function footGeo(d: Dims, side: number, kind: 'shoe' | 'foot' | 'sole' | 'strap') {
  const H = d.H
  const sole = -d.ankleH
  const z0 = -d.heel, z1 = d.footLen - d.heel
  const hw = d.footW / 2 * (kind === 'sole' ? 1.1 : kind === 'foot' ? 0.94 : kind === 'strap' ? 1.02 : 1.06)
  const wTab: [number, number][] = [[0, 0.32], [0.06, 0.74], [0.2, 0.82], [0.5, 0.93], [0.74, 1], [0.9, 0.86], [1, 0.4]]
  const hTab: [number, number][] = kind === 'shoe'
    ? [[0, 0.018], [0.06, 0.05], [0.16, 0.062], [0.32, 0.058], [0.55, 0.042], [0.8, 0.03], [0.94, 0.022], [1, 0.012]]
    : [[0, 0.016], [0.06, 0.04], [0.18, 0.047], [0.35, 0.045], [0.6, 0.03], [0.82, 0.02], [0.95, 0.014], [1, 0.008]]
  const base = kind === 'foot' || kind === 'strap' ? sole + 0.009 * H : sole
  const rings: V3[][] = []
  const tRange: [number, number] = kind === 'strap' ? [0.6, 0.68] : kind === 'sole' ? [-0.02, 1.02] : [0, 1]
  const nT = kind === 'strap' ? 2 : 8
  for (let i = 0; i <= nT; i++) {
    const t = tRange[0] + (tRange[1] - tRange[0]) * i / nT
    const tc = clamp(t, 0, 1)
    const z = z0 + (z1 - z0) * t
    const w = hw * tab(wTab, tc)
    let h = (kind === 'sole' ? 0.0095 : tab(hTab, tc)) * H
    if (kind === 'strap') h = h * 1.08 + 0.002 * H
    const hb = Math.min(kind === 'sole' ? 0.004 * H : 0.012 * H, h * 0.4)
    // A slight outward splay of the toes, mirrored per side.
    const x0 = side * 0.004 * H * tc
    const spring = kind === 'shoe' ? 0.006 * H * Math.max(0, tc - 0.8) / 0.2 : 0
    const r: V3[] = []
    const n = 10
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2
      const c = Math.cos(a), sn = Math.sin(a)
      const cx = Math.sign(c) * Math.pow(Math.abs(c), 0.7)
      const sy = Math.sign(sn) * Math.pow(Math.abs(sn), sn > 0 ? 1 : 0.5)
      const y = sn >= 0 ? base + hb + (h - hb) * sy : base + hb * (1 + sy)
      r.push([x0 + w * cx, y + spring, z])
    }
    rings.push(r)
  }
  // The rings run along +Z: build them as a loft along that axis.
  return surface(rings)
}

function shoeLines(d: Dims, side: number): LineData {
  const H = d.H
  const l = emptyLines()
  const sole = -d.ankleH
  const z0 = -d.heel, z1 = d.footLen - d.heel
  // Welt line round the sole, and the lacing down the instep.
  const hw = d.footW / 2 * 1.06
  const wTab: [number, number][] = [[0, 0.32], [0.06, 0.74], [0.2, 0.82], [0.5, 0.93], [0.74, 1], [0.9, 0.86], [1, 0.4]]
  for (const s of [1, -1]) {
    const pts: V3[] = []
    for (let k = 1; k <= 9; k++) {
      const t = k / 10
      pts.push([side * 0.004 * H * t + s * (hw * tab(wTab, t) * 0.985 + 0.0006 * H), sole + 0.008 * H, z0 + (z1 - z0) * t])
    }
    polyline(l, pts)
  }
  const lace: V3[] = []
  for (let k = 0; k <= 4; k++) {
    const t = 0.3 + 0.3 * k / 4
    const h = tab([[0, 0.018], [0.06, 0.05], [0.16, 0.062], [0.32, 0.058], [0.55, 0.042], [0.8, 0.03], [0.94, 0.022], [1, 0.012]], t) * H
    lace.push([side * 0.004 * H * t, sole + h + 0.0008 * H, z0 + (z1 - z0) * t])
  }
  polyline(l, lace)
  return l
}

/** A thin plate through three or more points (in order), extruded a hair along its normal. */
function plate(pts: V3[], thick: number) {
  const a = pts[0]!, b = pts[1]!, c = pts[2]!
  const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  let n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  const l = Math.hypot(...n) || 1
  n = [n[0] / l * thick, n[1] / l * thick, n[2] / l * thick]
  const r0 = pts.map(p => [p[0] - n[0] / 2, p[1] - n[1] / 2, p[2] - n[2] / 2] as V3)
  const r1 = pts.map(p => [p[0] + n[0] / 2, p[1] + n[1] / 2, p[2] + n[2] / 2] as V3)
  return surface([r0, r1])
}
