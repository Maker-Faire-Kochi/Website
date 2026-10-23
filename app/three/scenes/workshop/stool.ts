import * as THREE from 'three'
import { Assembly, blockGeometry, type Materials } from '../../core/kit'
import { STOOL, STOOL_PARTS, stoolPartPosition } from './layout'
import { movableParts } from './merge'

/**
 * A joined stool: seat with wedged through-tenons, four legs, four round
 * rungs. Each part is its own rigid assembly on its own node so it can lift
 * away along its joint axis; faint guide lines join every tenon to its socket
 * while the stool is apart, like the axis lines of an anatomy drawing.
 */
export function buildStool(m: Materials, vc: THREE.Material) {
  const root = new THREE.Group()
  root.name = 'stool'
  root.position.set(STOOL.x, 0, STOOL.z)

  const { seat, leg, rung } = STOOL
  const seatGeo = blockGeometry(seat.w, seat.t, seat.w)
  const wedge = blockGeometry(leg.tenon, 0.001, leg.w * 0.9)
  const legGeo = blockGeometry(leg.w, leg.top, leg.w)
  const tenonGeo = blockGeometry(leg.tenon, seat.t - 0.001, leg.w * 0.9)
  const span = leg.at * 2
  const rungX = new THREE.CylinderGeometry(rung.r, rung.r, span, 24).rotateZ(Math.PI / 2)
  const rungZ = new THREE.CylinderGeometry(rung.r, rung.r, span, 24).rotateX(Math.PI / 2)

  const seatA = new Assembly().add(seatGeo, 'wood')
  // End grain of the four through-tenons, flush on the seat top.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) seatA.add(wedge, 'woodDark', { pos: [sx * leg.at, seat.t / 2 + 0.0005, sz * leg.at] })
  }
  const legA = new Assembly()
    .add(legGeo, 'woodDark', { pos: [0, leg.top / 2, 0] })
    .add(tenonGeo, 'woodDark', { pos: [0, leg.top + (seat.t - 0.001) / 2, 0] })

  const nodes: THREE.Object3D[] = []
  const targets: THREE.Mesh[] = []
  for (const p of STOOL_PARTS) {
    const g = p.kind === 'seat'
      ? seatA.build(m, 'stool:seat')
      : p.kind === 'leg'
        ? legA.build(m, 'stool:leg')
        : new Assembly().add(p.kind === 'rungX' ? rungX : rungZ, 'wood').build(m, `stool:${p.kind}`)
    g.position.set(...p.base)
    root.add(g)
    nodes.push(g)
    g.traverse(o => (o as THREE.Mesh).isMesh && targets.push(o as THREE.Mesh))
  }
  ;[seatGeo, wedge, legGeo, tenonGeo, rungX, rungZ].forEach(g => g.dispose())
  // Nine parts that only ever translate: one mesh and one set of hairlines
  // (merge.ts), the parts moved by rewriting vertex positions -- 2 draws, not 17.
  const parts = movableParts(nodes, root, vc, m.line, 'stool', 0.75)
  root.add(parts.group)
  targets.length = 0
  targets.push(parts.mesh)
  const off = new Float32Array(STOOL_PARTS.length * 3)
  let lastU = 0

  // Guides: leg tenon -> seat socket (4), rung end -> leg socket (8).
  const guidePos = new THREE.Float32BufferAttribute(new Float32Array(12 * 2 * 3), 3)
  guidePos.setUsage(THREE.DynamicDrawUsage)
  const guideGeo = new THREE.BufferGeometry()
  guideGeo.setAttribute('position', guidePos)
  const guides = new THREE.LineSegments(guideGeo, m.lineFaint)
  guides.name = 'stool:guides'
  guides.frustumCulled = false
  guides.visible = false
  root.add(guides)

  const legs = STOOL_PARTS.map((p, i) => ({ p, i })).filter(e => e.p.kind === 'leg')
  const legIdx = legs.map(e => e.i)
  // Guide pairs worked out once, so moving the parts allocates nothing.
  const rungs = STOOL_PARTS.map((p, i) => ({ p, i })).filter(e => e.p.kind === 'rungX' || e.p.kind === 'rungZ').map(({ p, i }) => ({
    i,
    ends: [-1, 1].map(s => ({
      s,
      owner: legs.find(({ p: lp }) => p.kind === 'rungX'
        ? Math.sign(lp.base[0]) === s && Math.sign(lp.base[2]) === Math.sign(p.base[2])
        : Math.sign(lp.base[2]) === s && Math.sign(lp.base[0]) === Math.sign(p.base[0]))!.i,
    })),
  }))
  const cur = STOOL_PARTS.map(() => [0, 0, 0] as [number, number, number])

  return {
    root,
    targets,
    /** Places every part for explode progress u; exactly the assembled transforms at u = 0. */
    set(u: number) {
      if (u === lastU) return
      lastU = u
      STOOL_PARTS.forEach((p, i) => {
        stoolPartPosition(p, u, cur[i]!)
        off[i * 3] = cur[i]![0] - p.base[0]
        off[i * 3 + 1] = cur[i]![1] - p.base[1]
        off[i * 3 + 2] = cur[i]![2] - p.base[2]
      })
      parts.move(off)
      guides.visible = u > 0.01
      if (!guides.visible) return
      const arr = guidePos.array as Float32Array
      let o = 0
      const seatP = cur[0]!
      for (const i of legIdx) {
        const l = cur[i]!
        const base = STOOL_PARTS[i]!.base
        arr[o++] = l[0]; arr[o++] = l[1] + leg.top; arr[o++] = l[2]
        arr[o++] = seatP[0] + base[0]; arr[o++] = seatP[1] - seat.t / 2; arr[o++] = seatP[2] + base[2]
      }
      // Each rung end points at the leg it belongs to, at the rung's height.
      for (const { i, ends } of rungs) {
        const r = cur[i]!
        const isX = STOOL_PARTS[i]!.kind === 'rungX'
        for (const { s, owner } of ends) {
          const l = cur[owner]!
          arr[o++] = r[0] + (isX ? s * leg.at : 0); arr[o++] = r[1]; arr[o++] = r[2] + (isX ? 0 : s * leg.at)
          arr[o++] = l[0]; arr[o++] = r[1]; arr[o++] = l[2]
        }
      }
      guidePos.needsUpdate = true
    },
  }
}
