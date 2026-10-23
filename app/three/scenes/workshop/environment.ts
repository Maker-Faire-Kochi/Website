import * as THREE from 'three'
import { Assembly, blockGeometry, extrude, type Materials } from '../../core/kit'
import { rng } from '../../core/rng'

/**
 * The room round the bench, so the drawing runs to every screen edge when the
 * scene is shown full-bleed: a concrete floor laid in slabs, the back wall
 * with a skirting board, a pegboard of hand tools, a wall rack of timber and
 * a few offcuts leaning in the corner -- plus sawdust swept under the bench.
 *
 * Everything here is still, so it is ONE assembly (materials + 1 draw calls)
 * and one Points object for the dust. The slabs are separate boxes only so
 * their joints draw as hairlines; they still merge into one mesh.
 */

export const ROOM = {
  /** Back wall face. */
  wallZ: -0.95,
  wallH: 3.6,
  /** Floor extent: wide and deep enough for 21:9 and a tall phone frame. */
  x0: -9,
  x1: 9,
  z1: 9,
  slab: 1.2,
}

/** Pegboard centre and size, and the timber rack's span (exported for framing). */
export const PEGBOARD = { x: 1.15, y: 1.42, w: 1.1, h: 0.62 }
export const TIMBER = { x0: -2.5, x1: -1.05 }
/** Sawhorses with a plank, out on the floor left of the bench. */
export const HORSES = { x0: -2.9, x1: -1.6, z: 0.9 }

function poly(pts: [number, number][]) {
  const s = new THREE.Shape()
  s.moveTo(pts[0]![0], pts[0]![1])
  for (const [x, y] of pts.slice(1)) s.lineTo(x, y)
  s.closePath()
  return s
}

export function buildRoom(m: Materials): THREE.Group {
  const a = new Assembly()
  const own: THREE.BufferGeometry[] = []
  const g = <T extends THREE.BufferGeometry>(geo: T) => (own.push(geo), geo)
  const W = ROOM.wallZ

  // Floor slabs, top face at y = 0, from the wall to well in front.
  const S = ROOM.slab
  const slab = g(blockGeometry(S, 0.04, S))
  for (let x = ROOM.x0; x < ROOM.x1; x += S) {
    for (let z = W; z < ROOM.z1; z += S) a.add(slab, 'mid', { pos: [x + S / 2, -0.02, z + S / 2] })
  }

  // Back wall, with a skirting board along its foot.
  const span = ROOM.x1 - ROOM.x0
  a.add(g(blockGeometry(span, ROOM.wallH, 0.1)), 'light', { pos: [0, ROOM.wallH / 2, W - 0.05] })
  a.add(g(blockGeometry(span, 0.09, 0.018)), 'wood', { pos: [0, 0.045, W + 0.009] })

  // Pegboard on two battens, with tools hanging on it.
  {
    const { x, y, w, h } = PEGBOARD
    const z = W + 0.03
    a.add(g(blockGeometry(w, h, 0.012)), 'woodDark', { pos: [x, y, z] })
    const batten = g(blockGeometry(w + 0.04, 0.04, 0.02))
    for (const dy of [-h / 2 + 0.06, h / 2 - 0.06]) a.add(batten, 'wood', { pos: [x, y + dy, W + 0.012] })
    const f = z + 0.006
    // Try square: steel blade in a wooden stock.
    a.add(g(blockGeometry(0.03, 0.22, 0.012)), 'wood', { pos: [x - 0.42, y + 0.05, f + 0.006] })
    a.add(g(blockGeometry(0.2, 0.025, 0.003)), 'metal', { pos: [x - 0.31, y + 0.15, f + 0.004] })
    // Claw hammer, head up.
    a.add(g(blockGeometry(0.022, 0.28, 0.018)), 'wood', { pos: [x - 0.2, y - 0.02, f + 0.009] })
    a.add(g(blockGeometry(0.11, 0.028, 0.024)), 'dark', { pos: [x - 0.205, y + 0.13, f + 0.012] })
    // Three chisels in a row, handles up.
    const blade = g(blockGeometry(0.012, 0.09, 0.004))
    const handle = g(blockGeometry(0.022, 0.1, 0.02))
    for (let i = 0; i < 3; i++) {
      const cx = x - 0.06 + i * 0.05
      a.add(blade, 'metal', { pos: [cx, y - 0.06, f + 0.004] })
      a.add(handle, 'woodDark', { pos: [cx, y + 0.035, f + 0.01] })
    }
    // Bar clamp: a steel bar with a jaw at each end.
    a.add(g(blockGeometry(0.018, 0.42, 0.008)), 'metal', { pos: [x + 0.17, y, f + 0.004] })
    const jaw = g(blockGeometry(0.07, 0.03, 0.022))
    a.add(jaw, 'dark', { pos: [x + 0.2, y + 0.19, f + 0.011] })
    a.add(jaw, 'dark', { pos: [x + 0.2, y - 0.1, f + 0.011] })
    // Spirit level, hung level.
    a.add(g(blockGeometry(0.34, 0.035, 0.022)), 'metal', { pos: [x + 0.32, y - 0.2, f + 0.011], rot: [0, 0, Math.PI / 2] })
    // Coping saw: a dark bow frame.
    a.add(g(extrude(poly([[0, 0], [0.16, 0], [0.16, 0.012], [0.012, 0.012], [0.012, 0.11], [0.16, 0.11], [0.16, 0.122], [0, 0.122]]), 0.008, 1)),
      'dark', { pos: [x + 0.36, y + 0.08, f + 0.004] })
  }

  // Timber rack on the wall: three steel arms per post, boards along them.
  {
    const { x0, x1 } = TIMBER
    const post = g(blockGeometry(0.05, 1.9, 0.04))
    const arm = g(blockGeometry(0.04, 0.03, 0.34))
    const levels = [0.55, 1.05, 1.55]
    for (const px of [x0 + 0.15, x1 - 0.15]) {
      a.add(post, 'dark', { pos: [px, 1.0, W + 0.02] })
      for (const y of levels) a.add(arm, 'dark', { pos: [px, y, W + 0.2] })
    }
    const L = x1 - x0 + 0.3
    const R = rng(23)
    levels.forEach((y, li) => {
      const n = 2 + (li % 2)
      for (let i = 0; i < n; i++) {
        const t = 0.022 + R.range(0, 0.012)
        const w = 0.09 + R.range(0, 0.06)
        const len = L - R.range(0, 0.4)
        a.add(g(blockGeometry(len, t, w)), i % 2 ? 'woodDark' : 'wood', {
          pos: [(x0 + x1) / 2 + R.range(-0.1, 0.1), y + 0.015 + t / 2 + (i > 1 ? t : 0), W + 0.07 + i * 0.1 + (i > 1 ? -0.1 : 0)],
        })
      }
    })
  }

  // Offcuts leaning in against the wall, left of the timber rack (seen past
  // the carpenter's back from the three-quarter-front view).
  {
    const R = rng(41)
    for (let i = 0; i < 4; i++) {
      const h = 0.9 + R.range(0, 0.6)
      const lean = 0.12 + R.range(0, 0.06)
      const w = 0.08 + R.range(0, 0.07)
      const x = -3.4 + i * 0.13
      // Foot on the floor, top against the wall.
      const z = W + 0.015 + Math.sin(lean) * h / 2 + 0.01
      a.add(g(blockGeometry(w, h, 0.022)), i % 2 ? 'wood' : 'woodDark', {
        pos: [x, Math.cos(lean) * h / 2, z], rot: [-lean, 0, 0],
      })
    }
  }

  // A pair of sawhorses with a plank across them, out on the floor to the
  // left: the next job waiting. Splayed legs pinned to a top rail.
  {
    const { x0, x1, z } = HORSES
    const legH = 0.6
    const leg = g(blockGeometry(0.045, legH, 0.03))
    const rail = g(blockGeometry(0.07, 0.05, 0.5))
    for (const x of [x0 + 0.2, x1 - 0.2]) {
      a.add(rail, 'woodDark', { pos: [x, legH - 0.02, z] })
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          // Splayed out and to the side; the foot on the floor, the top under the rail.
          a.add(leg, 'woodDark', { pos: [x + sx * 0.06, legH / 2 - 0.02, z + sz * 0.17], rot: [-sz * 0.12, 0, sx * 0.2] })
        }
      }
    }
    a.add(g(blockGeometry(x1 - x0, 0.028, 0.2)), 'wood', { pos: [(x0 + x1) / 2, legH + 0.019, z] })
    a.add(g(blockGeometry(x1 - x0 - 0.3, 0.022, 0.14)), 'wood', { pos: [(x0 + x1) / 2 + 0.1, legH + 0.044, z - 0.02] })
  }

  const group = a.build(m, 'room')
  own.forEach(geo => geo.dispose())
  return group
}

/**
 * Old sawdust on the floor: denser under the board's free end where the saw
 * works, thinning out round the bench. Seeded, so the poster and the page agree.
 */
export function sawdustPositions(n: number) {
  const R = rng(97)
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const near = i < n * 0.6
    const cx = near ? 0.38 : 0
    const cz = near ? 0.36 : 0.1
    const sx = near ? 0.35 : 1.1
    const sz = near ? 0.3 : 0.6
    // Sum of uniforms: a soft-edged heap, not a box.
    out[i * 3] = cx + (R.next() + R.next() + R.next() - 1.5) * sx
    out[i * 3 + 1] = 0.0015
    out[i * 3 + 2] = cz + (R.next() + R.next() + R.next() - 1.5) * sz
  }
  return out
}
