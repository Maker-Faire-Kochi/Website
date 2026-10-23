import * as THREE from 'three'
import { Assembly, beamGeometry, blockGeometry, discGeometry, extrude, pinGeometry, type Materials } from '../../core/kit'
import { BENCH, BOARD, CHISEL_BLOCK, H, LEG, RACK, TOP_T, VICE } from './layout'

/**
 * Everything that never moves, as ONE rigid assembly: the slotted-beam bench
 * frame, its thick wood top, the shelf, the front vice with the board clamped
 * in it, and the tool rack behind. One assembly costs (materials + 1) draws.
 *
 * Construction is meant to be believable: every beam joint lies face to face
 * with a plain pin through both; the shelf rests on the low stretchers and the
 * top on the aprons, so the front and back frames are tied together by wood,
 * not by beams meeting at impossible angles.
 */
export function buildBench(m: Materials): THREE.Group {
  const a = new Assembly()
  const own: THREE.BufferGeometry[] = []
  const g = <T extends THREE.BufferGeometry>(geo: T) => (own.push(geo), geo)

  const vertical: [number, number, number] = [0, 0, Math.PI / 2]
  const pinR = 0.012

  // Legs: vertical slotted beams, broad face to the front.
  const legLen = LEG.y1 - LEG.y0
  const leg = g(beamGeometry({
    length: legLen,
    width: LEG.w,
    thickness: LEG.t,
    holes: [0, LEG.stretcher - LEG.y0, legLen],
    slots: [[0.2, legLen - 0.09]],
  }))
  const foot = g(blockGeometry(0.09, 0.03, 0.06))
  const span = LEG.x * 2
  const rail = g(beamGeometry({
    length: span,
    width: LEG.w,
    thickness: LEG.t,
    holes: [0, span],
    slots: [[0.12, span / 2 - 0.1], [span / 2 + 0.1, span - 0.12]],
  }))
  const jointPin = g(pinGeometry(pinR, LEG.t * 2 + 0.02))
  const footPin = g(pinGeometry(pinR, LEG.t + 0.02))
  const railZ = LEG.z + LEG.t
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * LEG.x
      const z = sz * LEG.z
      a.add(leg, 'dark', { pos: [x, LEG.y0, z], rot: vertical })
      a.add(foot, 'dark', { pos: [x, 0.015, z] })
      a.add(footPin, 'light', { pos: [x, LEG.y0, z] })
      for (const y of [LEG.stretcher, LEG.y1]) a.add(jointPin, 'light', { pos: [x, y, sz * (LEG.z + LEG.t / 2)] })
    }
  }
  // Low stretchers and top aprons, outside the legs, front and back.
  for (const sz of [-1, 1]) {
    for (const y of [LEG.stretcher, LEG.y1]) a.add(rail, 'dark', { pos: [-LEG.x, y, sz * railZ] })
  }

  // Top, resting on the aprons; shelf resting on the low stretchers.
  a.add(g(blockGeometry(BENCH.x1 - BENCH.x0, TOP_T, BENCH.z1 - BENCH.z0)), 'wood', { pos: [0, H - TOP_T / 2, 0] })
  const shelfY = LEG.stretcher + LEG.w / 2 + 0.01
  a.add(g(blockGeometry(span - LEG.w - 0.01, 0.02, (railZ + LEG.t / 2) * 2)), 'wood', { pos: [0, shelfY, 0] })

  // Board on edge, clamped between the bench's front edge and the vice jaw.
  a.add(g(blockGeometry(BOARD.x1 - BOARD.x0, BOARD.top - BOARD.bottom, BOARD.t)), 'woodDark', {
    pos: [(BOARD.x0 + BOARD.x1) / 2, (BOARD.top + BOARD.bottom) / 2, BOARD.z],
  })

  // Front vice: wood jaw, metal screw through the apron, wooden tommy bar
  // (dropped vertical through the screw head), two guide rods.
  const jawZ = BOARD.front + VICE.t / 2
  a.add(g(blockGeometry(VICE.w, VICE.h, VICE.t)), 'wood', { pos: [VICE.x, H - VICE.h / 2, jawZ] })
  const screwZ0 = LEG.z
  const screwZ1 = BOARD.front + VICE.t + VICE.proud
  a.add(g(pinGeometry(0.012, screwZ1 - screwZ0)), 'metal', { pos: [VICE.x, VICE.screwY, (screwZ0 + screwZ1) / 2] })
  a.add(g(discGeometry(0.028, 0.012)), 'metal', { pos: [VICE.x, VICE.screwY, BOARD.front + VICE.t + 0.006] })
  const bar = g(new THREE.CylinderGeometry(0.008, 0.008, 0.24, 12))
  // Hanging through the screw head: the top knob rests on it, the rest below.
  const barZ = screwZ1 - 0.012
  const barY = VICE.screwY - 0.1
  a.add(bar, 'woodDark', { pos: [VICE.x, barY, barZ] })
  const knob = g(new THREE.CylinderGeometry(0.014, 0.014, 0.022, 24))
  for (const s of [-1, 1]) a.add(knob, 'woodDark', { pos: [VICE.x, barY + s * 0.12, barZ] })
  const rod = g(pinGeometry(0.008, BOARD.front + VICE.t - screwZ0))
  for (const s of [-1, 1]) {
    a.add(rod, 'metal', { pos: [VICE.x + s * 0.12, H - 0.17, (screwZ0 + BOARD.front + VICE.t) / 2] })
  }

  // Tool rack: two uprights pinned to the top's back edge, two crossbars, one peg.
  const upLen = RACK.high - (H - 0.03)
  const upright = g(beamGeometry({
    length: upLen,
    width: 0.06,
    thickness: 0.04,
    holes: [0, RACK.low - (H - 0.03), upLen],
    slots: [[0.06, RACK.low - H - 0.02], [RACK.low - H + 0.09, upLen - 0.06]],
  }))
  const cross = g(beamGeometry({
    length: RACK.x * 2,
    width: 0.06,
    thickness: 0.04,
    holes: [0, RACK.x * 2],
    slots: [[0.1, RACK.x - 0.08], [RACK.x + 0.08, RACK.x * 2 - 0.1]],
  }))
  const rackPin = g(pinGeometry(0.011, 0.1))
  for (const s of [-1, 1]) {
    a.add(upright, 'light', { pos: [s * RACK.x, H - 0.03, RACK.z], rot: vertical })
    a.add(rackPin, 'light', { pos: [s * RACK.x, H - 0.03, RACK.z + 0.02] })
    for (const y of [RACK.low, RACK.high]) a.add(rackPin, 'light', { pos: [s * RACK.x, y, RACK.z + 0.02] })
  }
  for (const y of [RACK.low, RACK.high]) a.add(cross, 'light', { pos: [-RACK.x, y, RACK.z + 0.04] })
  const peg = g(pinGeometry(0.008, 0.07))
  a.add(peg, 'light', { pos: [RACK.peg, RACK.high, RACK.z + 0.075] })

  // A back saw hangs on the peg by its handle, toe down: a rectangular
  // blade under a dark spine. It never moves, so it is part of this assembly.
  {
    const x = RACK.peg
    const z = RACK.pegZ + 0.005
    const top = RACK.high + 0.03
    const bl = 0.26
    const y = top - 0.13 - bl / 2
    a.add(g(blockGeometry(0.075, bl, 0.002)), 'metal', { pos: [x + 0.008, y, z] })
    a.add(g(blockGeometry(0.012, bl, 0.008)), 'dark', { pos: [x - 0.034, y, z] })
    const handle = new THREE.Shape()
    handle.moveTo(-0.045, 0)
    handle.lineTo(0.045, 0)
    handle.lineTo(0.05, -0.1)
    handle.lineTo(0.03, -0.14)
    handle.lineTo(-0.035, -0.14)
    handle.lineTo(-0.05, -0.1)
    handle.closePath()
    const hole = new THREE.Path()
    hole.moveTo(-0.025, -0.02)
    hole.lineTo(0.025, -0.02)
    hole.lineTo(0.03, -0.075)
    hole.lineTo(-0.03, -0.075)
    hole.closePath()
    handle.holes.push(hole)
    a.add(g(extrude(handle, 0.02, 1)), 'wood', { pos: [x, top, z] })
  }

  // The chisel's block: it stands upright in a socket in the top.
  {
    const b = CHISEL_BLOCK
    a.add(g(blockGeometry(b.w, b.top - H, b.d)), 'woodDark', { pos: [b.x, (b.top + H) / 2, b.z] })
  }

  const group = a.build(m, 'bench')
  own.forEach(geo => geo.dispose())
  return group
}

/**
 * The marks the tools leave, as ONE instanced dark box: the rip kerf where it
 * shows (along the top edge and down the end grain) and the chisel's mortise.
 * Each instance is a unit box hanging below y = 0, so a cut grows down from
 * the edge it starts on.
 */
export function buildMarks(m: Materials) {
  const geo = new THREE.BoxGeometry(1, 1, 1)
  geo.translate(0, -0.5, 0)
  const mesh = new THREE.InstancedMesh(geo, m.face.dark, 3)
  mesh.name = 'marks'
  mesh.frustumCulled = false
  return mesh
}
