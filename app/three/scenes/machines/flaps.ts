import * as THREE from 'three'
import { EVENT, EVENT_START } from '../../../composables/useCountdown'
import { CARD_H, CARD_Z, CASE, FLAP, FLAP_Z, GLYPH_H, LABEL, display, nameplate } from './layout'
import { flapState, wheels, type WheelSpec } from './odometer'
import type { Phase } from './sim'

/**
 * The split-flap display: every card, flap and name plate of the counter in
 * ONE mesh (one atlas, one draw) plus ONE set of hairlines, rewritten in
 * place each frame from the units' positions (and the nameplate, when there
 * is one, from the event's phase). Each unit is four quads: the
 * upper half of the figure it is turning to, the lower half of the figure it
 * is leaving, and the falling flap -- the old upper half on its face, the new
 * lower half on its back -- hinged on the split between them. At rest the
 * flap hangs down and the unit simply shows its figure.
 */

// ── Atlas ─────────────────────────────────────────────────────────────────

/**
 * One card per digit across the top (each the card's full shape, so a half
 * card is half a cell), the nameplate's three faces (one per phase) in the
 * middle, the group plates along the bottom. 2048 x 1024, a power of two, so
 * it mipmaps.
 */
const ATLAS = { w: 2048, h: 1024, cellW: 180, wordW: 512 }
const CELL_H = Math.ceil(ATLAS.cellW * CARD_H / FLAP.w)
const WORD_H = Math.round(ATLAS.wordW * LABEL.h / LABEL.w)
const WORDS = ['DAYS', 'HOURS', 'MINUTES', 'SECONDS'] as const
/** The nameplate's cells: the plate's own shape (it only exists with three day units). */
const PLATE = nameplate(wheels(3))!
const PLATE_PX = { y0: CELL_H + 24, h: 560, w: Math.round(560 * (PLATE.x1 - PLATE.x0) / (PLATE.y1 - PLATE.y0)) }
const PHASES: Phase[] = ['upcoming', 'live', 'ended']
/**
 * What the nameplate says: the opening date (from EVENT, in Kochi's own
 * time zone, so a visitor elsewhere never reads the 4th), then that the faire
 * is on, then thanks; the city under each in smaller capitals.
 */
export function plateLines(phase: Phase): string[] {
  const ist = (o: Intl.DateTimeFormatOptions) => EVENT_START.toLocaleDateString('en-GB', { ...o, timeZone: 'Asia/Kolkata' }).toUpperCase()
  if (phase === 'live') return ['OPEN', 'NOW']
  if (phase === 'ended') return ['THANK', 'YOU']
  return ['OPENS', ist({ day: 'numeric', month: 'short' }), ist({ year: 'numeric' })]
}
const PLACE = EVENT.placeLocality.toUpperCase()
/** Campaign colours, as sRGB bytes: the cards are white with ink figures, the plates ink with yellow words. */
const INK = '#222222'
const CARD = '#FFFFFF'
const YELLOW = '#FFE86C'
/**
 * The campaign's display face, as on the page; while it is still loading
 * (or if it never does) a heavy system face stands in, and the atlas is
 * redrawn once it arrives.
 */
const FACE = `"Dela Gothic One", "Arial Black", "Helvetica Neue", sans-serif`
export const DISPLAY_FONT = '400 120px "Dela Gothic One"'

export function displayFontReady(): boolean {
  return typeof document !== 'undefined' && Boolean(document.fonts?.check(DISPLAY_FONT))
}

export function buildAtlas() {
  const c = document.createElement('canvas')
  c.width = ATLAS.w
  c.height = ATLAS.h
  const g = c.getContext('2d')!
  const font = (px: number) => `400 ${px}px ${FACE}`

  function draw() {
    g.clearRect(0, 0, c.width, c.height)
    g.fillStyle = CARD
    g.fillRect(0, 0, ATLAS.cellW * 10, CELL_H)
    g.textAlign = 'center'
    g.textBaseline = 'alphabetic'
    g.fillStyle = INK
    // Size the figures by their measured height, so the printed figure is GLYPH_H tall.
    g.font = font(100)
    const asc = g.measureText('0').actualBoundingBoxAscent || 70
    const px = GLYPH_H * (ATLAS.cellW / FLAP.w) * 100 / asc
    g.font = font(px)
    const dAsc = g.measureText('0').actualBoundingBoxAscent || asc * px / 100
    for (let d = 0; d < 10; d++) g.fillText(String(d), (d + 0.5) * ATLAS.cellW, CELL_H / 2 + dAsc / 2)

    // Plates: yellow capitals on ink, as large as the longest word allows.
    const y0 = ATLAS.h - WORD_H
    g.fillStyle = INK
    g.fillRect(0, y0, ATLAS.wordW * WORDS.length, WORD_H)
    g.font = font(100)
    const hAsc = g.measureText('H').actualBoundingBoxAscent || 70
    let wpx = 0.5 * WORD_H * 100 / hAsc
    const track = 0.05
    g.font = font(wpx)
    const widest = Math.max(...WORDS.map(w => g.measureText(w).width + wpx * track * (w.length - 1)))
    if (widest > 0.86 * ATLAS.wordW) wpx *= 0.86 * ATLAS.wordW / widest
    g.font = font(wpx)
    if ('letterSpacing' in g) (g as any).letterSpacing = `${(wpx * track).toFixed(1)}px`
    const wAsc = g.measureText('H').actualBoundingBoxAscent || hAsc * wpx / 100
    g.fillStyle = YELLOW
    WORDS.forEach((w, i) => g.fillText(w, (i + 0.5) * ATLAS.wordW, y0 + WORD_H / 2 + wAsc / 2))
    if ('letterSpacing' in g) (g as any).letterSpacing = '0px'

    // Nameplate faces: ink, the big lines in yellow at one size for every
    // phase (set by the widest), a short yellow rule, the city smaller.
    // Room is left top and bottom for the plate's two bolts.
    const { y0: py, h: ph, w: pw } = PLATE_PX
    g.fillStyle = INK
    g.fillRect(0, py, pw * PHASES.length, ph)
    g.font = font(100)
    const pAsc = g.measureText('H').actualBoundingBoxAscent || 70
    const all = PHASES.flatMap(plateLines)
    const widestBig = Math.max(...all.map(l => g.measureText(l).width))
    const big = Math.min(0.84 * pw * 100 / widestBig, 0.11 * ph * 100 / pAsc)
    const bigCap = pAsc * big / 100
    const small = 0.6 * big
    const smallCap = pAsc * small / 100
    PHASES.forEach((phase, i) => {
      const lines = plateLines(phase)
      const cx = (i + 0.5) * pw
      const lead = bigCap * 1.75
      const block = lines.length * lead - (lead - bigCap) + bigCap * 0.9 + 6 + bigCap * 0.9 + smallCap
      let y = py + (ph - block) / 2 + bigCap
      g.fillStyle = YELLOW
      g.font = font(big)
      for (const l of lines) {
        g.fillText(l, cx, y)
        y += lead
      }
      y += bigCap * 0.9 - lead
      g.fillRect(cx - pw * 0.18, y, pw * 0.36, 6)
      y += 6 + bigCap * 0.9 + smallCap
      g.font = font(small)
      if ('letterSpacing' in g) (g as any).letterSpacing = `${(small * 0.12).toFixed(1)}px`
      g.fillText(PLACE, cx, y)
      if ('letterSpacing' in g) (g as any).letterSpacing = '0px'
    })
  }
  draw()

  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  // Unlit: the cards and plates print their exact colours; vertex colours
  // shade a flap as it turns away from the viewer.
  const material = new THREE.MeshBasicMaterial({
    map: tex,
    vertexColors: true,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
  return {
    material,
    /** Redraw with the display face once it has loaded. */
    redraw() {
      draw()
      tex.needsUpdate = true
    },
    dispose() {
      tex.dispose()
      material.dispose()
    },
  }
}

/** v of card height t (0 = the card's bottom edge) in digit d's cell; u0, u1 of the cell. */
const cellU = (d: number): [number, number] => [(d * ATLAS.cellW + 1) / ATLAS.w, ((d + 1) * ATLAS.cellW - 1) / ATLAS.w]
const cellV = (t: number) => 1 - (CELL_H - t / CARD_H * CELL_H) / ATLAS.h
/** u0, u1, v0 (bottom), v1 (top) of the nameplate's face for a phase. */
function plateUV(phase: Phase): [number, number, number, number] {
  const i = PHASES.indexOf(phase)
  const { y0, h, w } = PLATE_PX
  return [(i * w + 1) / ATLAS.w, ((i + 1) * w - 1) / ATLAS.w, 1 - (y0 + h) / ATLAS.h, 1 - y0 / ATLAS.h]
}

// ── The display ───────────────────────────────────────────────────────────

const GROUPS = ['days', 'hours', 'minutes', 'seconds'] as const
/** Quads per unit: upper card, lower card, flap face, flap back. */
const Q = 4

export class FlapBank {
  readonly mesh: THREE.Mesh
  readonly lines: THREE.LineSegments
  private readonly pos: Float32Array
  private readonly uv: Float32Array
  private readonly col: Float32Array
  private readonly seg: Float32Array
  private readonly xs: number[]
  private readonly hinge: number[]
  private readonly last: Float64Array
  /** Quad index of the nameplate, or -1 when this counter has none. */
  private readonly plateQ: number
  private readonly plate: ReturnType<typeof nameplate>

  constructor(private readonly list: WheelSpec[], material: THREE.Material, line: THREE.Material) {
    const D = display(list)
    this.xs = D.x
    this.hinge = D.hinge
    this.plate = nameplate(list)
    this.plateQ = this.plate ? list.length * Q + GROUPS.length : -1
    const quads = list.length * Q + GROUPS.length + (this.plate ? 1 : 0)
    this.pos = new Float32Array(quads * 4 * 3)
    this.uv = new Float32Array(quads * 4 * 2)
    this.col = new Float32Array(quads * 4 * 3).fill(1)
    const index: number[] = []
    for (let q = 0; q < quads; q++) {
      const b = q * 4
      // Flap backs (q % Q === 3 among the units) face the other way.
      const back = q < list.length * Q && q % Q === 3
      index.push(...(back ? [b, b + 2, b + 1, b, b + 3, b + 2] : [b, b + 1, b + 2, b, b + 2, b + 3]))
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage))
    g.setIndex(index)
    this.mesh = new THREE.Mesh(g, material)
    this.mesh.name = 'flaps'
    this.mesh.frustumCulled = false

    // Hairlines: three rectangles per unit (upper card, lower card, flap), one per plate.
    this.seg = new Float32Array((list.length * 3 + GROUPS.length + (this.plate ? 1 : 0)) * 4 * 2 * 3)
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.BufferAttribute(this.seg, 3).setUsage(THREE.DynamicDrawUsage))
    this.lines = new THREE.LineSegments(lg, line)
    this.lines.frustumCulled = false

    // Name plates, centred under their groups on the case face.
    GROUPS.forEach((grp, i) => {
      const box = D.groups.find(b => b.group === grp)!
      const cx = (box.x0 + box.x1) / 2
      const x0 = cx - LABEL.w / 2
      const x1 = cx + LABEL.w / 2
      const y0 = box.labelY - LABEL.h / 2
      const y1 = box.labelY + LABEL.h / 2
      const z = CASE.front + 0.004
      const corners = [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]]
      const u0 = i * ATLAS.wordW / ATLAS.w
      const u1 = (i + 1) * ATLAS.wordW / ATLAS.w
      this.quad(list.length * Q + i, corners, u0, u1, [0, 0, WORD_H / ATLAS.h, WORD_H / ATLAS.h], 1)
      this.rect(list.length * 3 + i, corners)
    })
    if (this.plate) {
      const { x0, x1, y0, y1 } = this.plate
      const z = CASE.front + 0.004
      this.rect(list.length * 3 + GROUPS.length, [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]])
      this.setPlate('upcoming')
    }
    this.last = new Float64Array(list.length).fill(NaN)
  }

  /** Turn the nameplate to the face for this phase of the event. */
  setPlate(phase: Phase) {
    if (!this.plate) return
    const { x0, x1, y0, y1 } = this.plate
    const z = CASE.front + 0.004
    const [u0, u1, v0, v1] = plateUV(phase)
    this.quad(this.plateQ, [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], u0, u1, [v0, v0, v1, v1], 1)
    const g = this.mesh.geometry
    g.getAttribute('position').needsUpdate = true
    g.getAttribute('uv').needsUpdate = true
    g.getAttribute('color').needsUpdate = true
    this.lines.geometry.getAttribute('position').needsUpdate = true
  }

  /**
   * Write quad q: corners bottom-left, bottom-right, top-right, top-left,
   * and the v of each corner (so a flap's back can run its texture the
   * other way up).
   */
  private quad(q: number, c: number[][], u0: number, u1: number, v: number[], shade: number) {
    for (let k = 0; k < 4; k++) {
      this.pos.set(c[k]!, (q * 4 + k) * 3)
      this.uv[(q * 4 + k) * 2] = k === 1 || k === 2 ? u1 : u0
      this.uv[(q * 4 + k) * 2 + 1] = v[k]!
      this.col.fill(shade, (q * 4 + k) * 3, (q * 4 + k) * 3 + 3)
    }
  }

  private rect(r: number, c: number[][]) {
    for (let k = 0; k < 4; k++) {
      this.seg.set(c[k]!, (r * 8 + k * 2) * 3)
      this.seg.set(c[(k + 1) % 4]!, (r * 8 + k * 2 + 1) * 3)
    }
  }

  /** Place every unit at its position (in faces, continuous) -- see flapState(). */
  set(positions: ArrayLike<number>) {
    let changed = false
    const sp = FLAP.split / 2
    for (let i = 0; i < this.list.length; i++) {
      const hy = this.hinge[i]!
      const p = positions[i]!
      if (p === this.last[i]) continue
      this.last[i] = p
      changed = true
      const w = this.list[i]!
      const { face, from, theta } = flapState(p, w.faces)
      const now = w.label(face)
      const was = w.label(from)
      const x0 = this.xs[i]! - FLAP.w / 2
      const x1 = this.xs[i]! + FLAP.w / 2
      const top = [[x0, hy + sp, CARD_Z], [x1, hy + sp, CARD_Z], [x1, hy + sp + FLAP.half, CARD_Z], [x0, hy + sp + FLAP.half, CARD_Z]]
      const bottom = [[x0, hy - sp - FLAP.half, CARD_Z], [x1, hy - sp - FLAP.half, CARD_Z], [x1, hy - sp, CARD_Z], [x0, hy - sp, CARD_Z]]
      const c = Math.cos(theta)
      const s = Math.sin(theta)
      const at = (x: number, r: number) => [x, hy + r * c, FLAP_Z + r * s]
      const flap = [at(x0, sp), at(x1, sp), at(x1, sp + FLAP.half), at(x0, sp + FLAP.half)]
      const vTop = [cellV(FLAP.half + FLAP.split), cellV(FLAP.half + FLAP.split), cellV(CARD_H), cellV(CARD_H)]
      const vBottom = [cellV(0), cellV(0), cellV(FLAP.half), cellV(FLAP.half)]
      const [nu0, nu1] = cellU(now)
      const [wu0, wu1] = cellU(was)
      const q = i * Q
      // Upper card: the figure being turned to. Lower card: the one being left (hidden while the flap is down).
      this.quad(q, top, nu0, nu1, vTop, 1)
      this.quad(q + 1, bottom, wu0, wu1, vBottom, 1)
      // The flap shades as it turns edge-on: faces lit square-on, darker on its way through.
      this.quad(q + 2, flap, wu0, wu1, vTop, 0.7 + 0.3 * Math.max(0, c))
      this.quad(q + 3, flap, nu0, nu1, [cellV(FLAP.half), cellV(FLAP.half), cellV(0), cellV(0)], 0.7 + 0.3 * Math.max(0, -c))
      this.rect(i * 3, top)
      this.rect(i * 3 + 1, bottom)
      this.rect(i * 3 + 2, flap)
    }
    if (!changed) return
    const g = this.mesh.geometry
    g.getAttribute('position').needsUpdate = true
    g.getAttribute('uv').needsUpdate = true
    g.getAttribute('color').needsUpdate = true
    this.lines.geometry.getAttribute('position').needsUpdate = true
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.lines.geometry.dispose()
  }
}
