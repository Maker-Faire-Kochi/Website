import * as THREE from 'three'
import { Assembly, blockGeometry, pinGeometry, type Materials } from '../../core/kit'
import { keepOutDistance, type KeepOut, type Obstacle } from '../contact'
import { BALL, BLOCK, type Ball, type Block } from './props'

/**
 * The hero's stage: robot football straight on the page's yellow -- no
 * board, no plinths: the ground is the field yellow itself (buildField, an
 * unlit quad), and the page's text floats on it as on the rest of the page.
 * The text is an INVISIBLE wall (hero.ts keeps every robot, the ball and
 * the props out of it); nothing here is ever drawn inside it either.
 *
 * The pitch spans the free screen: two goal lines at the far ends of the
 * longest free span across it, touchlines as far up and down as the floor
 * is free all the way across (hero.ts), all marked in hairline -- touchlines,
 * goal lines, halfway line, centre circle and spot, a box in front of each
 * goal -- and every marking stops short of the text. A goal on each goal
 * line (posts in the defending team's colour, hairline nets), a cone in each
 * corner of the pitch that is on free floor.
 *
 * buildField() is the fill, once; buildPitch() is everything that follows the
 * layout and is rebuilt when it changes. Draw calls: field 1; pitch: markings
 * and nets 1, furniture by material (two goal colours, dark cones, light cone
 * bases) + their hairlines 1.
 *
 * Geometry the director needs (goal mouths, cones) comes from the same
 * functions that build it, so what the robots play with is exactly what is
 * drawn.
 */

/** The pitch (world x, z), m. */
export interface Pitch {
  /** The goal lines: each goal stands just inside one, its back on it. */
  x0: number
  x1: number
  /** The touchlines. */
  z0: number
  z1: number
  /** The row through both goal mouths (the pitch's long axis). */
  gz: number
  /**
   * Floor behind each goal line to the end of the free floor, m: filled with
   * invisible posts (fieldObstacles), so nothing gets in behind a goal and
   * wedges there between its net and the wall.
   */
  back: number
  /** The page's text and the screen's edges on the floor: no marking, cone or goal inside them. */
  keep: readonly KeepOut[]
}

/**
 * A goal at each end of the pitch, standing on the floor with its back on the
 * goal line: mouth half-width, depth, crossbar height, post and net radius.
 * The mouth is the plane `depth` in from the goal line; the ball is in when
 * its centre is past it, between the posts.
 */
export const GOAL = { half: 0.25, depth: 0.08, h: 0.085, post: 0.006, net: 0.012 }
/**
 * Corner cones: one in each corner of the pitch, `inset` in from both lines
 * -- corner flags, out of every lane (cones in the keepers' boxes floored a
 * keeper every few seconds). `off` is the keeper's box depth from the goal
 * line and `side` its half-width.
 */
export const CONE = { r: 0.02, h: 0.055, inset: 0.035, off: 0.27, side: 0.29 }
/**
 * The nets stop what is low (the ball, feet); above this a robot that falls
 * into a goal lies on the net -- it is a soft mesh, not a wall.
 */
const NET_H = 0.05
/** The hero's ground: --field-yellow in main.css, byte for byte (the page's own yellow, no seam). */
export const FIELD = '#FFE86C'
/** Markings stop this far short of the text's walls, m. */
const MARK_CLEAR = 0.02

/** Centre and half-extents: the centre is on the goals' row; `hz` the nearer touchline's distance from it. */
export const pitchCentre = (p: Pitch) => ({ cx: (p.x0 + p.x1) / 2, cz: p.gz, hx: (p.x1 - p.x0) / 2, hz: Math.max(0.05, Math.min(p.gz - p.z0, p.z1 - p.gz)) })

const kdClear = { d: 0, e: 0 }
/** Is (x, z) at least m clear of every keep-out? */
function clear(p: Pitch, x: number, z: number, m: number) {
  for (const k of p.keep) if (keepOutDistance(k, x, z, kdClear).d < m) return false
  return true
}

/** Cone positions: the pitch's four corners -- those on free floor. */
export function conesOf(p: Pitch): [number, number][] {
  const out: [number, number][] = []
  for (const x of [p.x0 + CONE.inset, p.x1 - CONE.inset]) {
    for (const z of [p.z0 + CONE.inset, p.z1 - CONE.inset]) if (clear(p, x, z, CONE.r * 2.6)) out.push([x, z])
  }
  return out
}
/**
 * The pitch's static obstacles for the contact solver: each goal's side and
 * back nets as rows of posts (gaps narrower than the ball), and the cones.
 * Each has a top: a body part above it passes over.
 */
export function fieldObstacles(p: Pitch): Obstacle[] {
  const { cz } = pitchCentre(p)
  const out: Obstacle[] = []
  for (const [xg, s] of [[p.x0, 1], [p.x1, -1]] as const) {
    for (const side of [-1, 1]) {
      for (const t of [0, 0.5, 1]) out.push({ x: xg + s * GOAL.depth * t, z: cz + side * GOAL.half, r: GOAL.net, h: NET_H })
    }
    for (let k = 1; k < 8; k++) out.push({ x: xg + s * GOAL.net, z: cz - GOAL.half + k / 8 * GOAL.half * 2, r: GOAL.net, h: NET_H })
  }
  for (const [x, z] of conesOf(p)) out.push({ x, z, r: CONE.r, h: CONE.h })
  if (p.back > 0.005) {
    // Behind each goal: a row of posts filling the gap to the wall.
    const r = p.back / 2 + 0.01, span = GOAL.half + 0.12
    const k = Math.ceil(2 * span / r)
    for (const [xg, s] of [[p.x0, 1], [p.x1, -1]] as const) {
      for (let i = 0; i <= k; i++) out.push({ x: xg - s * p.back / 2, z: cz - span + 2 * span * i / k, r })
    }
  }
  return out
}

/**
 * The yellow field: a clip-space quad filling the slot, drawn first with no
 * depth, its shader writing the sRGB bytes straight out (no lighting, no
 * colour-space conversion, no tone mapping) -- which is what makes it match
 * the CSS yellow exactly. NOT scene.background: that leaves the renderer's
 * clear colour yellow, and the stage's whole-canvas clear at the top of the
 * next frame would paint every other slot's surroundings yellow too.
 */
export function buildField() {
  const raw = parseInt(FIELD.slice(1), 16)
  const mat = new THREE.ShaderMaterial({
    uniforms: { field: { value: new THREE.Vector3((raw >> 16 & 255) / 255, (raw >> 8 & 255) / 255, (raw & 255) / 255) } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.999, 1.0); }',
    fragmentShader: 'uniform vec3 field; void main() { gl_FragColor = vec4(field, 1.0); }',
    depthTest: false,
    depthWrite: false,
  })
  const geo = new THREE.PlaneGeometry(2, 2)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = -10
  return {
    mesh,
    dispose() {
      mesh.removeFromParent()
      geo.dispose()
      mat.dispose()
    },
  }
}

/**
 * Parts every pitch rebuild uses, made once and shared (by key): an
 * assembly's hairlines come from an edge pass per source geometry (cached
 * per geometry in kit.ts), and that pass was most of a relayout's time when
 * every rebuild made its goal posts and cones afresh. Never disposed: a
 * handful of small geometries, alive as long as the module.
 */
const parts = new Map<string, THREE.BufferGeometry>()
function part(key: string, make: () => THREE.BufferGeometry) {
  let g = parts.get(key)
  if (!g) {
    g = make()
    parts.set(key, g)
  }
  return g
}

export function buildPitch(mats: Materials, p: Pitch) {
  const group = new THREE.Group()
  group.name = 'pitch'
  const { cx, cz, hz } = pitchCentre(p)

  const asm = new Assembly()
  // Goals: four posts, a crossbar across the mouth and two top bars back to
  // the goal line, in the colour of the team that defends it (red at -X, the
  // accent at +X). The nets are hairlines (with the markings below).
  const upright = part('upright', () => pinGeometry(GOAL.post, GOAL.h))
  const crossbar = part('crossbar', () => pinGeometry(GOAL.post, GOAL.half * 2 + GOAL.post * 2))
  const topBar = part('topBar', () => pinGeometry(GOAL.post, GOAL.depth))
  for (const [xg, s] of [[p.x0, 1], [p.x1, -1]] as const) {
    const col = s > 0 ? 'red' : 'accent'
    const xm = xg + s * GOAL.depth, xb = xg + s * GOAL.post
    for (const side of [-1, 1]) {
      asm.add(upright, col, { pos: [xm, GOAL.h / 2, cz + side * GOAL.half], rot: [Math.PI / 2, 0, 0] })
      asm.add(upright, col, { pos: [xb, GOAL.h / 2, cz + side * GOAL.half], rot: [Math.PI / 2, 0, 0] })
      asm.add(topBar, col, { pos: [(xm + xb) / 2, GOAL.h, cz + side * GOAL.half], rot: [0, Math.PI / 2, 0] })
    }
    asm.add(crossbar, col, { pos: [xm, GOAL.h, cz] })
  }
  // Cones: the pitch's corners on free floor.
  const cone = part('cone', () => new THREE.ConeGeometry(CONE.r, CONE.h, 24))
  const coneBase = part('coneBase', () => blockGeometry(CONE.r * 2.6, 0.004, CONE.r * 2.6))
  for (const [x, z] of conesOf(p)) {
    asm.add(cone, 'dark', { pos: [x, CONE.h / 2 + 0.004, z] })
    asm.add(coneBase, 'light', { pos: [x, 0.002, z] })
  }
  group.add(asm.build(mats, 'pitch'))

  // Markings in hairline, and the nets. A floor marking is cut in 1 cm
  // pieces and only the pieces clear of the text are kept: lines stop short
  // of a words block and carry on beyond it.
  const m: number[] = []
  const line = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => m.push(x0, y0, z0, x1, y1, z1)
  const y = 0.0006
  const seg = (x0: number, z0: number, x1: number, z1: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.01))
    let from = -1
    for (let i = 0; i <= n; i++) {
      const ok = clear(p, x0 + (x1 - x0) * i / n, z0 + (z1 - z0) * i / n, MARK_CLEAR)
      if (ok && from < 0) from = i
      if ((!ok || i === n) && from >= 0) {
        const to = ok ? i : i - 1
        if (to > from) line(x0 + (x1 - x0) * from / n, y, z0 + (z1 - z0) * from / n, x0 + (x1 - x0) * to / n, y, z0 + (z1 - z0) * to / n)
        from = -1
      }
    }
  }
  seg(p.x0, p.z0, p.x1, p.z0)
  seg(p.x1, p.z0, p.x1, p.z1)
  seg(p.x1, p.z1, p.x0, p.z1)
  seg(p.x0, p.z1, p.x0, p.z0)
  seg(cx, p.z0, cx, p.z1)
  const R = Math.min(hz * 0.6, 0.15)
  for (let i = 0; i < 48; i++) {
    const a0 = i / 48 * Math.PI * 2, a1 = (i + 1) / 48 * Math.PI * 2
    seg(cx + Math.cos(a0) * R, cz + Math.sin(a0) * R, cx + Math.cos(a1) * R, cz + Math.sin(a1) * R)
  }
  seg(cx - 0.01, cz, cx + 0.01, cz)
  seg(cx, cz - 0.01, cx, cz + 0.01)
  for (const [xg, s] of [[p.x0, 1], [p.x1, -1]] as const) {
    const xb = xg + s * CONE.off, zb = Math.min(CONE.side, hz)
    seg(xg, cz - zb, xb, cz - zb)
    seg(xb, cz - zb, xb, cz + zb)
    seg(xb, cz + zb, xg, cz + zb)
    // Nets: verticals on the back, a grid on the top and sides.
    const xm = xg + s * GOAL.depth, xr = xg + s * GOAL.post
    for (let k = 0; k <= 8; k++) {
      const z = cz - GOAL.half + k / 8 * GOAL.half * 2
      line(xr, 0, z, xr, GOAL.h, z)
      line(xm, GOAL.h, z, xr, GOAL.h, z)
    }
    for (let k = 1; k < 4; k++) line(xr, GOAL.h * k / 4, cz - GOAL.half, xr, GOAL.h * k / 4, cz + GOAL.half)
    for (const side of [-1, 1]) {
      const z = cz + side * GOAL.half
      for (let k = 1; k < 4; k++) {
        const x = xm + (xr - xm) * k / 4
        line(x, 0, z, x, GOAL.h, z)
        line(xm, GOAL.h * k / 4, z, xr, GOAL.h * k / 4, z)
      }
    }
  }
  const markGeo = new THREE.BufferGeometry()
  markGeo.setAttribute('position', new THREE.Float32BufferAttribute(m, 3))
  group.add(new THREE.LineSegments(markGeo, mats.lineFaint))

  return {
    group,
    dispose() {
      group.removeFromParent()
      // The assembly's merged geometries and the markings are this pitch's own; the shared parts are not.
      group.traverse((o) => {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined
        if (g) g.dispose()
      })
    },
  }
}

export function buildProps(mats: Materials, ball: Ball, blocks: Block[]) {
  const geos: THREE.BufferGeometry[] = []
  const own = <G extends THREE.BufferGeometry>(g: G) => (geos.push(g), g)
  const group = new THREE.Group()
  group.name = 'props'

  // Ball: a light sphere with two crossing ink seams that roll with it.
  const ballNode = new THREE.Group()
  const sphere = new THREE.Mesh(own(new THREE.SphereGeometry(BALL.r, 24, 16)), mats.face.light)
  const seam: number[] = []
  const rs = BALL.r * 1.004
  for (let k = 0; k < 2; k++) {
    for (let i = 0; i < 40; i++) {
      const a0 = i / 40 * Math.PI * 2, a1 = (i + 1) / 40 * Math.PI * 2
      // A tennis-ball-like seam: a great circle wobbling across the equator.
      const p = (a: number) => {
        const w = 0.45 * Math.sin(2 * a)
        const x = Math.cos(a) * Math.cos(w), y = Math.sin(w), z = Math.sin(a) * Math.cos(w)
        return k === 0 ? [x * rs, y * rs, z * rs] : [y * rs, x * rs, z * rs]
      }
      seam.push(...p(a0), ...p(a1))
    }
  }
  const seamGeo = own(new THREE.BufferGeometry())
  seamGeo.setAttribute('position', new THREE.Float32BufferAttribute(seam, 3))
  ballNode.add(sphere, new THREE.LineSegments(seamGeo, mats.line))
  group.add(ballNode)

  // Blocks: one instanced mesh; their edges rewritten into one LineSegments.
  const boxGeo = own(new THREE.BoxGeometry(BLOCK.half * 2, BLOCK.h, BLOCK.half * 2))
  const blockMesh = new THREE.InstancedMesh(boxGeo, mats.face.woodDark, blocks.length)
  blockMesh.frustumCulled = false
  group.add(blockMesh)
  const edge = new THREE.EdgesGeometry(boxGeo)
  const edgeSrc = edge.attributes.position!.array as Float32Array
  const edgeBuf = new Float32Array(edgeSrc.length * blocks.length)
  const edgeGeo = own(new THREE.BufferGeometry())
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgeBuf, 3).setUsage(THREE.DynamicDrawUsage))
  edge.dispose()
  const edgeLines = new THREE.LineSegments(edgeGeo, mats.line)
  edgeLines.frustumCulled = false
  group.add(edgeLines)

  // Contact shadows for the ball and each block: one instanced quad.
  const shadowGeo = own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2))
  const shadows = new THREE.InstancedMesh(shadowGeo, mats.shadow, 1 + blocks.length)
  shadows.frustumCulled = false
  shadows.renderOrder = -1
  group.add(shadows)

  // Interpolation snapshots: ball x, z, quaternion, height; blocks x, z, yaw.
  const prev = new Float64Array(7 + 3 * blocks.length)
  const cur = new Float64Array(7 + 3 * blocks.length)
  const snap = (out: Float64Array) => {
    out[0] = ball.x
    out[1] = ball.z
    out[2] = ball.q[0]!
    out[3] = ball.q[1]!
    out[4] = ball.q[2]!
    out[5] = ball.q[3]!
    out[6] = ball.y
    blocks.forEach((b, i) => {
      out[7 + 3 * i] = b.x
      out[8 + 3 * i] = b.z
      out[9 + 3 * i] = b.yaw
    })
  }
  snap(prev)
  snap(cur)
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion()
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1)
  const up = new THREE.Vector3(0, 1, 0)

  return {
    group,
    /** Call once per step, after the props have stepped and been solved. */
    step() {
      prev.set(cur)
      snap(cur)
    },
    frame(alpha: number) {
      const l = (i: number) => prev[i]! + (cur[i]! - prev[i]!) * alpha
      ballNode.position.set(l(0), BALL.r + l(6), l(1))
      qa.set(prev[2]!, prev[3]!, prev[4]!, prev[5]!)
      qb.set(cur[2]!, cur[3]!, cur[4]!, cur[5]!)
      ballNode.quaternion.slerpQuaternions(qa, qb, alpha)
      shadows.setMatrixAt(0, m.compose(p.set(l(0), 0.0006, l(1)), q.identity(), s.set(BALL.r * 3.2, 1, BALL.r * 3.2)))
      for (let i = 0; i < blocks.length; i++) {
        const x = l(7 + 3 * i), z = l(8 + 3 * i), yaw = l(9 + 3 * i)
        q.setFromAxisAngle(up, yaw)
        m.compose(p.set(x, BLOCK.h / 2, z), q, s.set(1, 1, 1))
        blockMesh.setMatrixAt(i, m)
        // Edges: transform the shared edge list into this block's slot.
        const c = Math.cos(yaw), sn = Math.sin(yaw)
        const o = i * edgeSrc.length
        for (let k = 0; k < edgeSrc.length; k += 3) {
          const ex = edgeSrc[k]!, ey = edgeSrc[k + 1]!, ez = edgeSrc[k + 2]!
          edgeBuf[o + k] = x + ex * c + ez * sn
          edgeBuf[o + k + 1] = BLOCK.h / 2 + ey
          edgeBuf[o + k + 2] = z - ex * sn + ez * c
        }
        shadows.setMatrixAt(1 + i, m.compose(p.set(x, 0.0006, z), q, s.set(BLOCK.half * 3.4, 1, BLOCK.half * 3.4)))
      }
      blockMesh.instanceMatrix.needsUpdate = true
      shadows.instanceMatrix.needsUpdate = true
      edgeGeo.attributes.position!.needsUpdate = true
    },
    /** Meshes for picking: the ball sphere and the block instances. */
    ballMesh: sphere,
    blockMesh,
    dispose() {
      group.removeFromParent()
      geos.forEach(g => g.dispose())
    },
  }
}
