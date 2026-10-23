import * as THREE from 'three'
import type { Materials } from '../../core/kit'
import { IRON, JOINTS, LAMP, MAT_TOP, padWorld, PB, SPOOL, STATION, TOP, type V3 } from './bench-layout'
import { meterFrame, METER_DISPLAY } from './bench'
import type { Particle } from './bench-sim'

/**
 * Light, smoke and wires: the bench's living details.
 *
 * - fillets: a cone of solder on each pad, growing as it is fed (one instanced draw).
 * - particles: the flux smoke curling up off the joint and the chips and
 *   sawdust from the drill and the saw, as one RGBA point cloud.
 * - lampLight: the magnifier lamp's soft cone and the pool it lays on the mat.
 * - meterDisplay: the multimeter's LCD (a small canvas, redrawn only when
 *   the reading changes).
 * - ironCable: the iron's silicone lead, a tube re-laid every frame between
 *   the station's port and the iron's tail.
 * - solderWire: a hairline from the spool, through the left hand's pinch, to
 *   the wire's tip.
 */

/** Solder fillets: a squat cone per pad along the board normal, scaled by how much solder it has. */
export function buildFillets(m: Materials) {
  const geo = new THREE.ConeGeometry(0.0022, 0.0026, 12)
  geo.translate(0, 0.0013, 0)
  const mesh = new THREE.InstancedMesh(geo, m.face.metal, JOINTS)
  mesh.name = 'fillets'
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(PB.tilt, 0, 0))
  const mtx = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  function update(levels: ArrayLike<number>) {
    let any = false
    for (let k = 0; k < JOINTS; k++) {
      const v = Math.max(0, Math.min(1, levels[k]!))
      if (v > 0.01) any = true
      p.set(...padWorld(k))
      s.set(0.4 + 0.6 * v, v, 0.4 + 0.6 * v).multiplyScalar(v > 0.01 ? 1 : 0)
      mesh.setMatrixAt(k, mtx.compose(p, q, s))
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.visible = any
  }
  mesh.frustumCulled = false
  return { mesh, update, dispose: () => geo.dispose() }
}

function dotTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.5, 'rgba(255,255,255,0.8)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 32, 32)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Smoke and dust as one point cloud: colour and alpha per point. */
export function buildParticles(smokeN: number, dustN: number, dustColour: string) {
  const n = smokeN + dustN
  const pos = new Float32Array(n * 3)
  const col = new Float32Array(n * 4)
  const geo = new THREE.BufferGeometry()
  const pa = new THREE.BufferAttribute(pos, 3)
  const ca = new THREE.BufferAttribute(col, 4)
  pa.setUsage(THREE.DynamicDrawUsage)
  ca.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('position', pa)
  geo.setAttribute('color', ca)
  const tex = dotTexture()
  const mat = new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, map: tex, vertexColors: true, transparent: true, depthWrite: false })
  const points = new THREE.Points(geo, mat)
  points.name = 'particles'
  points.frustumCulled = false
  points.renderOrder = 3
  const smoke = new THREE.Color('#85857F')
  const dust = new THREE.Color(dustColour)
  function update(smokeP: Particle[], dustP: Particle[]) {
    let live = 0
    const put = (i: number, p: Particle, c: THREE.Color, a: number) => {
      pos[i * 3] = p.x
      pos[i * 3 + 1] = p.y
      pos[i * 3 + 2] = p.z
      col[i * 4] = c.r
      col[i * 4 + 1] = c.g
      col[i * 4 + 2] = c.b
      col[i * 4 + 3] = a
      if (a > 0.01) live++
    }
    smokeP.forEach((p, i) => {
      const u = p.life > 0 ? p.age / p.life : 1
      // Fades in over the first fifth, out over the rest: a wisp, never a puff.
      const a = u >= 1 ? 0 : 0.75 * Math.min(1, u * 6) * (1 - u) ** 1.2
      put(i, p, smoke, a)
    })
    dustP.forEach((p, i) => {
      const u = p.life > 0 ? p.age / p.life : 1
      put(smokeN + i, p, dust, u >= 1 ? 0 : 0.9 * (1 - u * u))
    })
    pa.needsUpdate = true
    ca.needsUpdate = true
    points.visible = live > 0
  }
  return {
    points,
    update,
    dispose() {
      geo.dispose()
      mat.dispose()
      tex.dispose()
    },
  }
}

/**
 * The lamp's light: a soft cone from the head down to the mat and the warm
 * pool it lays there, in one mesh with alpha per vertex (strong under the
 * head, gone at the cone's foot and the pool's rim). `set(level)` scales it.
 */
export function buildLampLight() {
  const top = LAMP.head[1] - 0.014
  const foot = MAT_TOP + 0.0015
  const h = top - foot
  const cone = new THREE.CylinderGeometry(LAMP.headR * 0.6, 0.15, h, 40, 6, true)
  cone.translate(LAMP.head[0], foot + h / 2, LAMP.head[2])
  const pool = new THREE.CircleGeometry(0.17, 40, 0, Math.PI * 2)
  pool.rotateX(-Math.PI / 2)
  pool.translate(LAMP.head[0], foot, LAMP.head[2])
  const parts = [cone, pool].map((g) => {
    const n = g.getAttribute('position').count
    const c = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      const y = g.getAttribute('position').getY(i)
      const x = g.getAttribute('position').getX(i) - LAMP.head[0]
      const z = g.getAttribute('position').getZ(i) - LAMP.head[2]
      const a = g === cone ? 0.16 * ((y - foot) / h) ** 1.6 : 0.2 * Math.max(0, 1 - Math.hypot(x, z) / 0.17) ** 1.5
      c.set([1, 0.96, 0.82, a], i * 4)
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 4))
    g.deleteAttribute('uv')
    g.deleteAttribute('normal')
    return g.index ? g.toNonIndexed() : g
  })
  const pos: number[] = []
  const col: number[] = []
  for (const g of parts) {
    pos.push(...(g.getAttribute('position').array as Float32Array))
    col.push(...(g.getAttribute('color').array as Float32Array))
  }
  ;[cone, pool, ...parts].forEach(g => g.dispose())
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4))
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 1 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'lampLight'
  mesh.renderOrder = 2
  return {
    mesh,
    set(level: number) {
      mesh.visible = level > 0.01
      mat.opacity = level
    },
    dispose() {
      geo.dispose()
      mat.dispose()
    },
  }
}

/** The multimeter's LCD: a canvas texture on a plane in the meter's face. */
export function buildMeterDisplay(ink: string) {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 56
  const g = c.getContext('2d')!
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.MeshBasicMaterial({ map: tex })
  const geo = new THREE.PlaneGeometry(0.062, 0.028)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'meterDisplay'
  mesh.applyMatrix4(new THREE.Matrix4().makeTranslation(...METER_DISPLAY).premultiply(meterFrame()))
  let shown = ''
  function show(text: string, unit: string) {
    const key = `${text}|${unit}`
    if (key === shown) return
    shown = key
    g.fillStyle = '#D9DED6'
    g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = ink
    g.font = '500 38px "IBM Plex Mono", ui-monospace, monospace'
    g.textAlign = 'right'
    g.textBaseline = 'middle'
    g.fillText(text, 100, 30)
    g.font = '500 16px "IBM Plex Mono", ui-monospace, monospace'
    g.textAlign = 'left'
    g.fillText(unit, 104, 38)
    tex.needsUpdate = true
  }
  return {
    mesh,
    show,
    dispose() {
      geo.dispose()
      mat.dispose()
      tex.dispose()
    },
  }
}

/**
 * A round cable of fixed topology whose path is re-laid every frame: N rings
 * of R vertices, positions and normals rewritten in place (no allocation).
 * Frames are parallel-transported along the path so the tube never twists.
 */
export function dynamicTube(mat: THREE.Material, n: number, radius: number, radial = 6) {
  const pos = new Float32Array(n * radial * 3)
  const nrm = new Float32Array(n * radial * 3)
  const idx: number[] = []
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j
      const b = i * radial + (j + 1) % radial
      const c = a + radial
      const d = b + radial
      idx.push(a, c, b, b, c, d)
    }
  }
  const geo = new THREE.BufferGeometry()
  const pa = new THREE.BufferAttribute(pos, 3)
  const na = new THREE.BufferAttribute(nrm, 3)
  pa.setUsage(THREE.DynamicDrawUsage)
  na.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('position', pa)
  geo.setAttribute('normal', na)
  geo.setIndex(idx)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  const T = new THREE.Vector3()
  const N = new THREE.Vector3()
  const B = new THREE.Vector3()
  const prevT = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const tmp = new THREE.Vector3()
  /** pts: n points (x, y, z flat). */
  function set(pts: Float32Array) {
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1)
      const i1 = Math.min(n - 1, i + 1)
      T.set(pts[i1 * 3]! - pts[i0 * 3]!, pts[i1 * 3 + 1]! - pts[i0 * 3 + 1]!, pts[i1 * 3 + 2]! - pts[i0 * 3 + 2]!).normalize()
      if (i === 0) {
        N.set(0, 1, 0).addScaledVector(T, -T.y)
        if (N.lengthSq() < 1e-6) N.set(1, 0, 0).addScaledVector(T, -T.x)
        N.normalize()
      }
      else {
        q.setFromUnitVectors(prevT, T)
        N.applyQuaternion(q).addScaledVector(T, -N.dot(T)).normalize()
      }
      prevT.copy(T)
      B.crossVectors(T, N)
      for (let j = 0; j < radial; j++) {
        const a = (j / radial) * Math.PI * 2
        tmp.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a))
        const k = (i * radial + j) * 3
        nrm[k] = tmp.x
        nrm[k + 1] = tmp.y
        nrm[k + 2] = tmp.z
        pos[k] = pts[i * 3]! + tmp.x * radius
        pos[k + 1] = pts[i * 3 + 1]! + tmp.y * radius
        pos[k + 2] = pts[i * 3 + 2]! + tmp.z * radius
      }
    }
    pa.needsUpdate = true
    na.needsUpdate = true
  }
  return { mesh, set, dispose: () => geo.dispose() }
}

const IRON_CABLE_N = 28

/** The iron's lead from the station port to the iron's tail: a sagging cubic, held above the bench. */
export function buildIronCable(m: Materials) {
  const tube = dynamicTube(m.face.dark, IRON_CABLE_N, 0.002)
  tube.mesh.name = 'ironCable'
  const pts = new Float32Array(IRON_CABLE_N * 3)
  const p0 = new THREE.Vector3(...STATION.port)
  const p1 = new THREE.Vector3()
  const p2 = new THREE.Vector3()
  const p3 = new THREE.Vector3()
  const c = new THREE.CubicBezierCurve3(p0, p1, p2, p3)
  const out = new THREE.Vector3()
  const ax = new THREE.Vector3()
  function update(tip: ArrayLike<number>, axis: ArrayLike<number>) {
    ax.set(axis[0]!, axis[1]!, axis[2]!)
    p3.set(tip[0]!, tip[1]!, tip[2]!).addScaledVector(ax, IRON.end + 0.004)
    const d = p0.distanceTo(p3)
    // Slack lead: it leaves the station forward and the iron along its axis, sagging between.
    const sag = 0.04 + 0.12 * Math.max(0, 0.6 - d)
    p1.set(p0.x, p0.y - sag, p0.z + 0.12)
    p2.copy(p3).addScaledVector(ax, 0.09)
    p2.y -= sag
    for (let i = 0; i < IRON_CABLE_N; i++) {
      c.getPoint(i / (IRON_CABLE_N - 1), out)
      // It lies on the bench rather than through it.
      out.y = Math.max(out.y, TOP + 0.003)
      pts[i * 3] = out.x
      pts[i * 3 + 1] = out.y
      pts[i * 3 + 2] = out.z
    }
    tube.set(pts)
  }
  return { mesh: tube.mesh, update, dispose: tube.dispose }
}

const WIRE_N = 22

/**
 * Solder wire: spool -> a slack loop -> the pinch -> straight to the tip. A
 * thin metal tube (0.8 mm wire drawn at 2.6 mm so it survives at bench scale).
 */
export function buildSolderWire(m: Materials) {
  const tube = dynamicTube(m.face.metal, WIRE_N, 0.0013, 5)
  tube.mesh.name = 'solderWire'
  const pos = new Float32Array(WIRE_N * 3)
  const a = new THREE.Vector3(...SPOOL.exit)
  const b = new THREE.Vector3()
  const mid = new THREE.Vector3()
  const out = new THREE.Vector3()
  function update(pinch: V3, tip: V3) {
    b.set(...pinch)
    mid.lerpVectors(a, b, 0.5)
    mid.y = Math.max(TOP + 0.004, Math.min(a.y, b.y) - 0.04)
    const loop = WIRE_N - 4
    for (let i = 0; i < loop; i++) {
      const t = i / (loop - 1)
      // Quadratic through the sag point.
      out.set(0, 0, 0)
        .addScaledVector(a, (1 - t) * (1 - t))
        .addScaledVector(mid, 2 * (1 - t) * t)
        .addScaledVector(b, t * t)
      out.y = Math.max(out.y, TOP + 0.002)
      pos.set([out.x, out.y, out.z], i * 3)
    }
    // The straight stick from the pinch to the tip (4 points so the tube's frames settle).
    for (let k = 0; k < 4; k++) {
      const t = (k + 1) / 4
      pos.set([pinch[0] + (tip[0] - pinch[0]) * t, pinch[1] + (tip[1] - pinch[1]) * t, pinch[2] + (tip[2] - pinch[2]) * t], (loop + k) * 3)
    }
    tube.set(pos)
  }
  return { line: tube.mesh, update, dispose: tube.dispose }
}

/**
 * The monitor's terminal: a canvas texture on the screen, a few lines of
 * text in the drawing's own ink-on-dark, redrawn only when the text or the
 * cursor changes (a handful of times a second at most).
 */
export function buildTerminal(frame: THREE.Matrix4, w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = 320
  c.height = 186
  const g = c.getContext('2d')!
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.MeshBasicMaterial({ map: tex })
  const geo = new THREE.PlaneGeometry(w, h)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'terminal'
  mesh.applyMatrix4(frame)
  let shown = ''
  function show(lines: string[], cursor: boolean) {
    const key = lines.join('\n') + (cursor ? '_' : '')
    if (key === shown) return
    shown = key
    g.fillStyle = '#2B2B2B'
    g.fillRect(0, 0, c.width, c.height)
    g.font = '500 15px "IBM Plex Mono", ui-monospace, monospace'
    g.textBaseline = 'top'
    g.fillStyle = '#E6E6DF'
    lines.forEach((l, i) => g.fillText(l, 12, 10 + i * 20))
    if (cursor) {
      const last = lines[lines.length - 1] ?? ''
      g.fillRect(12 + g.measureText(last).width + 2, 10 + (lines.length - 1) * 20, 8, 16)
    }
    tex.needsUpdate = true
  }
  return {
    mesh,
    show,
    dispose() {
      geo.dispose()
      mat.dispose()
      tex.dispose()
    },
  }
}
