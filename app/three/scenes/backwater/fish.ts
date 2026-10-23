import * as THREE from 'three'

/**
 * One small fish, a karimeen (pearl spot): a deep oval body tapering to a
 * narrow tail stalk, a forked tail, a dorsal fin along the back, a small
 * pectoral fin and a dark eye near the snout. Fish units: length 1 along +x,
 * the snout at +0.5, the tail's fork tips at -0.5; y up the back; the flank
 * faces +-z. One shared geometry for every fish (instanced), under 150
 * triangles: a gently cambered sheet seen from either side.
 *
 * Vertex colours: a slate-blue back fading to a silver belly, faint dark
 * vertical bands and a few pale spots, darker fins, a near-black eye.
 *
 * The tail flick BENDS the fish: one morph target displaces the rear half
 * sideways (out of the flank, +z) by fishBend(x) -- nothing at mid-body,
 * most at the tail -- so a flap curls the stalk and swings the fin. The ink
 * outline (FISH_INK) is bent the same way on the CPU.
 */

/** Body stations from snout to stalk: x, half-height above the centre line (back) and below it (belly). */
const STATIONS: [number, number, number][] = [
  [0.5, 0, 0],
  [0.46, 0.055, 0.05],
  [0.38, 0.115, 0.1],
  [0.27, 0.16, 0.135],
  [0.14, 0.18, 0.15],
  [0.0, 0.172, 0.14],
  [-0.12, 0.135, 0.105],
  [-0.21, 0.085, 0.065],
  [-0.27, 0.05, 0.04],
  [-0.31, 0.04, 0.034],
]
/** Where the stalk ends and the tail fin begins, and the fin's fork. */
const STALK_X = -0.31
const FORK: { top: [number, number], notch: [number, number], bottom: [number, number] } = {
  top: [-0.5, 0.15],
  notch: [-0.42, 0.0],
  bottom: [-0.5, -0.13],
}
/** Dorsal fin: base points along the back (x) and its ragged top edge (x, y). */
const DORSAL_BASE = [0.2, 0.08, -0.04, -0.15]
const DORSAL_TOP: [number, number][] = [[0.12, 0.25], [-0.02, 0.245], [-0.13, 0.2], [-0.2, 0.115]]
/** The sheet's camber at its middle line, at the body's deepest (fish units). */
const CAMBER = 0.03

/** Half-heights of the body at x (linear between stations), back and belly. */
function halfAt(x: number): [number, number] {
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const [x0, u0, l0] = STATIONS[i]!
    const [x1, u1, l1] = STATIONS[i + 1]!
    if (x <= x0 && x >= x1) {
      const t = (x0 - x) / (x0 - x1)
      return [u0 + (u1 - u0) * t, l0 + (l1 - l0) * t]
    }
  }
  return [0.04, 0.034]
}

/** Sideways (z) displacement at x for a full tail flick (fish units): none forward of mid-body. */
export function fishBend(x: number) {
  const d = Math.max(0, -0.04 - x)
  return 0.55 * d * d
}

/** The camber (z) of the sheet at (x, y): bulging along the middle line, flat at the edges and the fins. */
function camber(x: number, y: number) {
  const [up, lo] = halfAt(x)
  const h = y >= 0 ? up : lo
  if (h < 1e-6 || x < STALK_X) return 0
  const t = Math.min(1, Math.abs(y) / h)
  return CAMBER * (h / 0.18) * (1 - t * t)
}

/**
 * The ink outline, as segments [x0, y0, z0, x1, y1, z1] in fish units: the
 * sheet's edges and the fins' edges (z = 0 there), and the gill line drawn on
 * the cambered flank, once on each side.
 */
export const FISH_INK: [number, number, number, number, number, number][] = (() => {
  const flat: [number, number, number, number][] = []
  const segs = flat
  const back = STATIONS.map(([x, u]) => [x, u] as [number, number])
  const belly = STATIONS.map(([x, , l]) => [x, -l] as [number, number])
  for (let i = 0; i < back.length - 1; i++) segs.push([...back[i]!, ...back[i + 1]!])
  for (let i = 0; i < belly.length - 1; i++) segs.push([...belly[i]!, ...belly[i + 1]!])
  // The forked tail.
  const st = back[back.length - 1]!
  const sb = belly[belly.length - 1]!
  segs.push([...st, ...FORK.top], [...FORK.top, ...FORK.notch], [...FORK.notch, ...FORK.bottom], [...FORK.bottom, ...sb])
  // The dorsal fin's top edge, from the back up and along and down again.
  const b0: [number, number] = [DORSAL_BASE[0]!, halfAt(DORSAL_BASE[0]!)[0]]
  const pts = [b0, ...DORSAL_TOP]
  for (let i = 0; i < pts.length - 1; i++) segs.push([...pts[i]!, ...pts[i + 1]!])
  // The mouth: a short line back from the snout, a little open.
  segs.push([0.5, 0, 0.45, -0.012])
  const out = flat.map(([x0, y0, x1, y1]) => [x0, y0, 0, x1, y1, 0] as [number, number, number, number, number, number])
  // The gill line, on the flank (just proud of it, either side).
  for (let k = 0; k < 4; k++) {
    const xa = 0.3 - 0.01 * k
    const ya = 0.12 - 0.055 * k
    const xb = 0.3 - 0.01 * (k + 1)
    const yb = 0.12 - 0.055 * (k + 1)
    for (const side of [1, -1]) {
      out.push([xa, ya, side > 0 ? camber(xa, ya) + 0.005 : -0.005, xb, yb, side > 0 ? camber(xb, yb) + 0.005 : -0.005])
    }
  }
  return out
})()

export function buildFishGeometry() {
  const pos: number[] = []
  const bend: number[] = []
  const col: number[] = []
  const back = new THREE.Color('#33506A')
  const flank = new THREE.Color('#8EA3B3')
  const belly = new THREE.Color('#E4E9ED')
  const fin = new THREE.Color('#566A7A')
  const eye = new THREE.Color('#14181C')
  const pecFin = new THREE.Color('#7D90A0')
  const c = new THREE.Color()
  /** Body colour at (x, y): back to belly, with faint bands and pale spots. */
  const bodyColour = (x: number, y: number, out: THREE.Color) => {
    const [up, lo] = halfAt(x)
    const t = y >= 0 ? y / Math.max(1e-6, up) : -y / Math.max(1e-6, lo)
    if (y >= 0) out.copy(flank).lerp(back, Math.min(1, t * 1.1))
    else out.copy(flank).lerp(belly, Math.min(1, t * 1.3))
    // Karimeen: faint dark vertical bands over the flank.
    const band = Math.max(0, Math.cos((x - 0.06) * Math.PI / 0.13))
    if (x < 0.3 && x > -0.24) out.multiplyScalar(1 - 0.16 * band ** 6)
    return out
  }
  const vert = (x: number, y: number, z: number, colour: THREE.Color) => {
    pos.push(x, y, z)
    bend.push(0, 0, fishBend(x))
    col.push(colour.r, colour.g, colour.b)
  }
  const bodyVert = (x: number, y: number) => vert(x, y, camber(x, y), bodyColour(x, y, c))
  const tri = (a: () => void, b: () => void, d: () => void) => {
    a()
    b()
    d()
  }

  // Body: a grid of stations x five rows (belly edge, belly middle, centre line, back middle, back edge).
  const rows = [-1, -0.5, 0, 0.5, 1]
  const rowY = (x: number, r: number) => {
    const [up, lo] = halfAt(x)
    return r >= 0 ? r * up : r * lo
  }
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const xa = STATIONS[i]![0]
    const xb = STATIONS[i + 1]![0]
    for (let k = 0; k < rows.length - 1; k++) {
      const a0 = () => bodyVert(xa, rowY(xa, rows[k]!))
      const a1 = () => bodyVert(xa, rowY(xa, rows[k + 1]!))
      const b0 = () => bodyVert(xb, rowY(xb, rows[k]!))
      const b1 = () => bodyVert(xb, rowY(xb, rows[k + 1]!))
      // The snout column is a fan (its stations meet in a point).
      if (i > 0) tri(a0, b0, a1)
      tri(a1, b0, b1)
    }
  }
  // Pale spots: a few small diamonds on the flank, just proud of the sheet (both sides).
  const pale = new THREE.Color('#AFBFCB')
  for (const [sx, sy] of [[0.18, 0.06], [0.05, -0.03], [-0.08, 0.05], [0.1, 0.11]] as [number, number][]) {
    const r = 0.011
    for (const side of [1, -1]) {
      const z = camber(sx, sy) * (side > 0 ? 1 : 0) + side * 0.004
      tri(() => vert(sx + r, sy, z, pale), () => vert(sx, sy + r, z, pale), () => vert(sx - r, sy, z, pale))
      tri(() => vert(sx - r, sy, z, pale), () => vert(sx, sy - r, z, pale), () => vert(sx + r, sy, z, pale))
    }
  }
  // The forked tail fin, from the stalk (flat).
  const st = STATIONS[STATIONS.length - 1]!
  const S0: [number, number] = [st[0], st[1]]
  const S1: [number, number] = [st[0], -st[2]]
  const finV = (p: [number, number]) => () => vert(p[0], p[1], 0, fin)
  const mid: [number, number] = [STALK_X - 0.04, 0]
  tri(finV(S0), finV(FORK.top), finV(mid))
  tri(finV(FORK.top), finV(FORK.notch), finV(mid))
  tri(finV(mid), finV(FORK.notch), finV(FORK.bottom))
  tri(finV(S1), finV(mid), finV(FORK.bottom))
  tri(finV(S0), finV(mid), finV(S1))
  // The dorsal fin along the back.
  for (let i = 0; i < DORSAL_BASE.length - 1; i++) {
    const xa = DORSAL_BASE[i]!
    const xb = DORSAL_BASE[i + 1]!
    const ba: [number, number] = [xa, halfAt(xa)[0] - 0.01]
    const bb: [number, number] = [xb, halfAt(xb)[0] - 0.01]
    const ta = i === 0 ? DORSAL_TOP[0]! : DORSAL_TOP[i]!
    const tb = DORSAL_TOP[i + 1]!
    tri(finV(ba), finV(bb), finV(ta))
    tri(finV(ta), finV(bb), finV(tb))
  }
  // A small anal fin under the belly.
  const an0: [number, number] = [-0.04, -halfAt(-0.04)[1] + 0.01]
  const an1: [number, number] = [-0.2, -halfAt(-0.2)[1] + 0.01]
  tri(finV(an0), finV([-0.16, -0.19]), finV(an1))
  // Pectoral fin and eye on both flanks, just off the sheet.
  for (const side of [1, -1]) {
    const zp = (x: number, y: number) => camber(x, y) * (side > 0 ? 1 : 0) + side * 0.006
    tri(() => vert(0.25, -0.03, zp(0.25, -0.03), pecFin), () => vert(0.16, 0.0, zp(0.16, 0.0), pecFin), () => vert(0.17, -0.06, zp(0.17, -0.06), pecFin))
    const ex = 0.4
    const ey = 0.035
    const er = 0.022
    for (let k = 0; k < 6; k++) {
      const a0 = k / 6 * Math.PI * 2
      const a1 = (k + 1) / 6 * Math.PI * 2
      tri(
        () => vert(ex, ey, zp(ex, ey), eye),
        () => vert(ex + Math.cos(a0) * er, ey + Math.sin(a0) * er, zp(ex, ey), eye),
        () => vert(ex + Math.cos(a1) * er, ey + Math.sin(a1) * er, zp(ex, ey), eye),
      )
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.morphAttributes.position = [new THREE.Float32BufferAttribute(bend, 3)]
  g.morphTargetsRelative = true
  g.computeVertexNormals()
  return g
}
