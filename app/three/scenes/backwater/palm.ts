import * as THREE from 'three'
import { Assembly, extrude, type Materials } from '../../core/kit'
import { rng } from '../../core/rng'
import { trunkSegments } from './layout'

/**
 * One coconut palm, built ONCE and cloned for every palm on the bank (the
 * clones share these geometries, so three palms cost one palm's memory).
 *
 * Natural things may curve, so the trunk leans and the fronds droop -- but
 * both are still made of straight pieces: the trunk is a stack of short
 * turned segments whose joints draw the ring marks, and every frond is a
 * straight midrib in three drooping lengths carrying thin leaflet blades.
 */

export interface PalmParts {
  trunk: THREE.Group
  crown: THREE.Group
  geos: THREE.BufferGeometry[]
}

export function buildPalm(m: Materials): PalmParts {
  const geos: THREE.BufferGeometry[] = []

  // Trunk. 24 sides keeps the facet angle under the kit's edge threshold, so
  // the only hairlines are the segment rings: the joints of the stack.
  const trunkA = new Assembly()
  for (const s of trunkSegments().segs) {
    const len = s.len + 0.03 // overlap the next segment so the kink never opens a gap
    const g = new THREE.CylinderGeometry(s.rTop, s.rBot, len, 24)
    geos.push(g)
    const dir = new THREE.Vector3(-Math.sin(s.angle), Math.cos(s.angle), 0)
    const mid = new THREE.Vector3(...s.base).addScaledVector(dir, s.len / 2)
    trunkA.add(g, 'woodDark', { pos: [mid.x, mid.y, mid.z], rot: [0, 0, s.angle] })
  }
  const trunk = trunkA.build(m, 'palm-trunk')

  // Crown: a heart of young leaves, then fronds in two tiers.
  const crownA = new Assembly()
  const heart = new THREE.CylinderGeometry(0.07, 0.12, 0.42, 24)
  geos.push(heart)
  crownA.add(heart, 'leaf', { pos: [0, 0.12, 0] })

  // A unit leaflet: a narrow lancet, 1 m long, scaled per leaflet along x.
  const lancet = new THREE.Shape()
  lancet.moveTo(0, 0)
  lancet.lineTo(0.22, 0.04)
  lancet.lineTo(0.62, 0.028)
  lancet.lineTo(1, 0)
  lancet.lineTo(0.62, -0.028)
  lancet.lineTo(0.22, -0.04)
  lancet.closePath()
  const leaflet = extrude(lancet, 0.012, 1)
  geos.push(leaflet)

  // A unit midrib: 1 m along +x from the origin.
  const rib = new THREE.BoxGeometry(1, 0.045, 0.035)
  rib.translate(0.5, 0, 0)
  geos.push(rib)

  const r = rng(23)
  const X = new THREE.Vector3()
  const Y = new THREE.Vector3()
  const Z = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const mtx = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  /** Euler that turns +x onto dir with the part's face (z) as close to `face` as it can get. */
  const orient = (dir: THREE.Vector3, face: THREE.Vector3): [number, number, number] => {
    X.copy(dir).normalize()
    Z.copy(face).addScaledVector(X, -face.dot(X)).normalize()
    Y.crossVectors(Z, X)
    q.setFromRotationMatrix(mtx.makeBasis(X, Y, Z))
    e.setFromQuaternion(q)
    return [e.x, e.y, e.z]
  }

  const FRONDS = 12
  const p = new THREE.Vector3()
  const f = new THREE.Vector3()
  const side = new THREE.Vector3()
  const leafDir = new THREE.Vector3()
  for (let i = 0; i < FRONDS; i++) {
    const upper = i % 2 === 0
    const az = (i / FRONDS) * Math.PI * 2 + r.range(-0.15, 0.15)
    const elev = upper ? r.range(0.45, 0.7) : r.range(-0.05, 0.2)
    const total = r.range(2.5, 3.1) * (upper ? 0.92 : 1)
    const lens = [0.4, 0.33, 0.27].map(k => k * total) as [number, number, number]
    // Each length droops further than the one before: a frond hangs under its own weight.
    const droops = [0, 0.42, 0.9] as const
    side.set(-Math.sin(az), 0, Math.cos(az))
    p.set(Math.cos(az) * 0.06, 0.22, Math.sin(az) * 0.06)
    let along = 0
    for (const s of [0, 1, 2] as const) {
      const el = elev - droops[s]
      f.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el))
      crownA.add(rib, 'leaf', { pos: [p.x, p.y, p.z], rot: orient(f, side), scale: [lens[s], 1, 1] })
      // Three pairs a length: the crown still reads full, at three quarters the triangles.
      const pairs = 3
      for (let k = 0; k < pairs; k++) {
        const t = (k + 0.5) / pairs
        const frac = (along + t * lens[s]) / total
        const at = p.clone().addScaledVector(f, t * lens[s])
        // Leaflets: long near the middle of the frond, short at base and tip.
        const len = 0.78 * Math.min(1, frac * 4 + 0.35) * (1 - 0.6 * frac)
        for (const sgn of [-1, 1]) {
          leafDir.copy(f).multiplyScalar(0.55).addScaledVector(side, sgn * 0.8).add(new THREE.Vector3(0, -0.45, 0))
          crownA.add(leaflet, 'leaf', { pos: [at.x, at.y, at.z], rot: orient(leafDir, up), scale: [len, 1, 1] })
        }
      }
      p.addScaledVector(f, lens[s])
      along += lens[s]
    }
  }
  const crown = crownA.build(m, 'palm-crown')
  return { trunk, crown, geos }
}
