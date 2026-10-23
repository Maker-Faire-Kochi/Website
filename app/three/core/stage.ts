import * as THREE from 'three'
import { DT, FixedClock } from './clock'
import { createMaterials, type Materials } from './kit'
import { readPalette, type Palette } from './palette'

/**
 * ONE WebGL renderer for the whole page.
 *
 * A fixed, full-viewport, pointer-events:none canvas sits behind the content
 * (z-index -1; the paper is painted on <html>, so the canvas shows through
 * anything without its own background). Each scene is bound to a DOM slot;
 * every frame, each slot that intersects the viewport is drawn with a
 * scissor/viewport equal to its rect. That is the three.js "multiple scenes"
 * pattern: one context however many drawings the page carries.
 *
 * Only visible slots simulate. When motion is paused, nothing steps and the
 * stage renders on demand (scroll/resize) so still frames stay registered to
 * their slots.
 */

export type MotionState = 'running' | 'paused' | 'reduced'

export interface SlotPointer {
  /**
   * move: pointer moved (fine pointers only). tap: a short primary press and
   * release. down / up: the primary button pressed / released over the
   * drawing (mouse and pen) -- for grabbing and dragging; a tap also sends
   * its own down and up first.
   */
  kind: 'move' | 'tap' | 'leave' | 'down' | 'up'
  /** PointerEvent.buttons on move: non-zero while dragging. */
  buttons?: number
  /** CSS px relative to the slot's top-left. May lie outside the slot (pointer elsewhere in the input host). */
  x: number
  y: number
  /** Normalised device coordinates relative to the slot; copy into a Vector2 for Raycaster.setFromCamera. */
  ndc: { x: number, y: number }
}

export interface SceneContext {
  materials: Materials
  palette: Palette
  /** Deterministic still pose for poster capture: no noise, no wandering. */
  posterMode: boolean
  /** Touch-first device: no hover, so look/shy reactions must not depend on it. */
  coarse: boolean
  width: number
  height: number
}

export interface SceneInstance {
  scene: THREE.Scene
  camera: THREE.Camera
  /** One fixed simulation step of DT seconds. */
  step(dt: number): void
  /** Called once per rendered frame after stepping; alpha interpolates between the last two steps. */
  frame(alpha: number): void
  resize(width: number, height: number): void
  pointer?(p: SlotPointer): void
  /** Entering pause must drop queued reactions and pointer targets. */
  setPaused?(paused: boolean): void
  /**
   * Keyboard equivalents of pointer interactions (WCAG 2.1.1): DOM buttons call
   * these by name. Returns a short status for a live region, or null if the
   * action is unknown or cannot run now (e.g. paused).
   */
  action?(name: string): string | null
  dispose(): void
}

/**
 * May be async: a heavy scene should build in pieces and `await nextTask()`
 * between them, so no single main-thread task runs long enough to block input.
 */
export type SceneFactory = (ctx: SceneContext) => SceneInstance | Promise<SceneInstance>

/**
 * Size a scene to its slot. A full-bleed slot may name a FOCUS box,
 * `data-focus="x0 x1 y0 y1"` (fractions of the slot): the scene frames itself
 * for that box, and a view offset extends the same camera over the rest of the
 * slot, so text panels can cover one side of a full-screen drawing without
 * covering its subject. Pointer NDC stays slot-relative, which is exactly what
 * the offset projection expects; a scene's own px (hover labels) are in the
 * focus box's frame.
 */
function fit(s: { el: HTMLElement, inst: SceneInstance, w: number, h: number, focus: string }) {
  const f = s.el.dataset.focus ?? ''
  s.focus = f
  const [x0 = 0, x1 = 1, y0 = 0, y1 = 1] = f ? f.trim().split(/\s+/).map(Number) : []
  const fw = Math.max(1, s.w * (x1 - x0))
  const fh = Math.max(1, s.h * (y1 - y0))
  s.inst.resize(fw, fh)
  const cam = s.inst.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera
  if (!cam.setViewOffset) return
  if (f) cam.setViewOffset(fw, fh, -s.w * x0, -s.h * y0, Math.max(1, s.w), Math.max(1, s.h))
  else if (cam.view?.enabled) cam.clearViewOffset()
}

/** Yield to the browser so input and paint can run between chunks of work. */
export function nextTask(): Promise<void> {
  const s = (globalThis as any).scheduler
  if (s?.yield) return s.yield()
  return new Promise(resolve => setTimeout(resolve, 0))
}

export interface SlotHandle {
  el: HTMLElement
  pointer(p: SlotPointer): void
  action(name: string): string | null
  remove(): void
}

interface Slot {
  el: HTMLElement
  inst: SceneInstance
  materials: Materials
  clock: FixedClock
  visible: boolean
  w: number
  h: number
  drawn: boolean
  /** The slot's data-focus when last fitted (see fit()). */
  focus: string
  pendingMove: SlotPointer | null
  queue: SlotPointer[]
  onFirstFrame: () => void
  onFail: () => void
  calls: number
  triangles: number
}

const MAX_PIXELS = 2.5e6
const FRAME_SAMPLES = 240

export interface StageStats {
  calls: number
  triangles: number
  frameMs: number[]
  slots: { scene: string, calls: number, triangles: number, visible: boolean }[]
  dropped: number
}

class Stage {
  readonly canvas: HTMLCanvasElement
  readonly renderer: THREE.WebGLRenderer
  readonly palette: Palette
  private slots = new Set<Slot>()
  private io: IntersectionObserver
  private raf = 0
  private motion: MotionState = 'running'
  private lost = false
  private lastFrame = 0
  private frameMs: number[] = []
  private coarse = matchMedia('(pointer: coarse)').matches
  private disposed = false
  /** Builds in flight: they count as "in use" so an idle release cannot dispose the stage under them. */
  private pending = 0
  private readonly size2 = new THREE.Vector2()

  constructor() {
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.className = 'mf-stage'
    // z-index 0 and FIRST in <body>: the canvas paints above the page's
    // section backgrounds (non-positioned blocks) and below their content
    // (positioned, z-index 1 -- see .field in main.css). That is what lets a
    // figure sit directly on a yellow or blue field.
    Object.assign(canvas.style, {
      position: 'fixed', inset: '0', width: '100%', height: '100%',
      zIndex: '0', pointerEvents: 'none', display: 'block',
    })
    document.body.prepend(canvas)
    this.canvas = canvas
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' })
    }
    catch (e) {
      canvas.remove()
      throw e
    }
    this.renderer.setClearColor(0x000000, 0)
    // Cleared once per frame in tick(); an auto-clear per render() would wipe
    // every slot drawn before the current one (scissor or not).
    this.renderer.autoClear = false
    this.renderer.info.autoReset = false
    this.palette = readPalette()

    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const slot = this.find(e.target as HTMLElement)
        if (!slot) continue
        slot.visible = e.isIntersecting
        if (!slot.visible) {
          slot.clock.reset()
          slot.pendingMove = null
          slot.queue.length = 0
          slot.inst.pointer?.({ kind: 'leave', x: 0, y: 0, ndc: { x: 0, y: 0 } })
        }
      }
      this.kick()
    // A quarter screen of margin: an observer reports a frame or two late, and
    // a slot that is only marked visible once it is on screen is not drawn for
    // those frames -- its edge flashed the bare field as each chapter scrolled
    // in. tick() still draws only what actually intersects the viewport.
    }, { rootMargin: '25% 0px' })

    window.addEventListener('resize', this.kick, { passive: true })
    window.addEventListener('scroll', this.onScroll, { passive: true })
    document.addEventListener('visibilitychange', this.onVisibility)
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
  }

  /**
   * Builds the scene, compiles its shaders, then starts drawing it. Resolves to
   * null if `isCancelled()` turns true while it was building (the slot was
   * unmounted or motion was turned off): the half-built scene is disposed.
   */
  async add(el: HTMLElement, factory: SceneFactory, hooks: { onFirstFrame: () => void, onFail: () => void, posterMode: boolean, isCancelled: () => boolean }): Promise<SlotHandle | null> {
    const rect = el.getBoundingClientRect()
    this.pending++
    try {
      return await this.build(el, factory, hooks, rect)
    }
    finally {
      this.pending--
    }
  }

  private async build(el: HTMLElement, factory: SceneFactory, hooks: { onFirstFrame: () => void, onFail: () => void, posterMode: boolean, isCancelled: () => boolean }, rect: DOMRect): Promise<SlotHandle | null> {
    // Materials are per SLOT, not shared across the page: every scene has its
    // own lights state, so a material drawn in two scenes had its program
    // re-checked (getProgram/getParameters) in every slot, every frame --
    // about a tenth of a throttled frame. Materials are cheap; geometry is
    // what stays shared.
    const materials = createMaterials(this.palette)
    let inst: SceneInstance
    try {
      inst = await factory({
        materials,
      palette: this.palette,
      posterMode: hooks.posterMode,
      coarse: this.coarse,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      })
    }
    catch (e) {
      materials.dispose()
      throw e
    }
    // The focus actually fitted is kept, so a change during the async compile below is re-fitted.
    const fitted = { el, inst, w: rect.width, h: rect.height, focus: '' }
    fit(fitted)
    // Shader programs compile in parallel off the main thread where the
    // driver supports it (KHR_parallel_shader_compile), instead of inside the
    // first render() call, which was a ~135ms block at 4x CPU.
    await this.renderer.compileAsync(inst.scene, inst.camera).catch(() => {})
    if (hooks.isCancelled() || this.disposed) {
      inst.dispose()
      materials.dispose()
      return null
    }
    inst.setPaused?.(this.motion !== 'running')
    const slot: Slot = {
      el, inst, materials, clock: new FixedClock(), visible: false,
      w: rect.width, h: rect.height, drawn: false, focus: fitted.focus,
      pendingMove: null, queue: [],
      onFirstFrame: hooks.onFirstFrame, onFail: hooks.onFail,
      calls: 0, triangles: 0,
    }
    this.slots.add(slot)
    this.io.observe(el)
    this.kick()
    return {
      el,
      pointer: (p) => {
        if (this.motion !== 'running') return
        if (p.kind === 'move') slot.pendingMove = p
        else slot.queue.push(p)
        this.kick()
      },
      action: (name) => {
        if (this.motion !== 'running') return null
        const status = slot.inst.action?.(name) ?? null
        this.kick()
        return status
      },
      remove: () => this.remove(slot),
    }
  }

  setMotion(m: MotionState) {
    if (m === this.motion) return
    this.motion = m
    for (const s of this.slots) {
      s.clock.reset()
      s.pendingMove = null
      s.queue.length = 0
      s.inst.setPaused?.(m !== 'running')
    }
    this.kick()
  }

  stats(): StageStats {
    return {
      calls: [...this.slots].reduce((n, s) => n + (s.visible ? s.calls : 0), 0),
      triangles: [...this.slots].reduce((n, s) => n + (s.visible ? s.triangles : 0), 0),
      frameMs: this.frameMs.slice(),
      slots: [...this.slots].map(s => ({ scene: s.el.dataset.scene ?? '', calls: s.calls, triangles: s.triangles, visible: s.visible })),
      dropped: [...this.slots].reduce((n, s) => n + s.clock.dropped, 0),
    }
  }

  get size() {
    return this.slots.size + this.pending
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const s of this.slots) {
      s.inst.dispose()
      s.materials.dispose()
    }
    this.slots.clear()
    this.io.disconnect()
    window.removeEventListener('resize', this.kick)
    window.removeEventListener('scroll', this.onScroll)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.canvas.remove()
  }

  private find(el: HTMLElement) {
    for (const s of this.slots) if (s.el === el) return s
    return null
  }

  private remove(slot: Slot) {
    if (!this.slots.delete(slot)) return
    this.io.unobserve(slot.el)
    slot.inst.dispose()
    slot.materials.dispose()
    this.kick()
  }

  private kick = () => {
    if (!this.raf && !this.lost) this.raf = requestAnimationFrame(this.tick)
  }

  private onScroll = () => {
    // Keep frames coming while the page moves, running or not: a loop that had
    // gone idle (nothing visible) must be drawing again before a slot arrives.
    this.kick()
  }

  private onVisibility = () => {
    for (const s of this.slots) s.clock.reset()
    if (!document.hidden) this.kick()
  }

  private onLost = (e: Event) => {
    e.preventDefault()
    this.lost = true
    cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const s of this.slots) {
      s.drawn = false
      s.onFail()
    }
  }

  private onRestored = () => {
    this.lost = false
    for (const s of this.slots) s.clock.reset()
    this.kick()
  }

  private sizeCanvas() {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    const cap = this.coarse ? 1.5 : 2
    const dpr = Math.min(window.devicePixelRatio || 1, cap, Math.sqrt(MAX_PIXELS / Math.max(1, w * h)))
    if (this.renderer.getPixelRatio() !== dpr) this.renderer.setPixelRatio(dpr)
    const size = this.renderer.getSize(this.size2)
    if (size.x !== w || size.y !== h) this.renderer.setSize(w, h, false)
    return { w, h }
  }

  private tick = (now: number) => {
    this.raf = 0
    if (this.lost) return
    if (this.lastFrame) {
      this.frameMs.push(now - this.lastFrame)
      if (this.frameMs.length > FRAME_SAMPLES) this.frameMs.shift()
    }
    const { h: vh, w: vw } = this.sizeCanvas()
    const r = this.renderer
    r.setScissorTest(false)
    r.clear()
    r.setScissorTest(true)

    const running = this.motion === 'running' && !document.hidden
    let animating = false
    for (const s of this.slots) {
      if (!s.visible) continue
      const rect = s.el.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1 || rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) continue
      if (rect.width !== s.w || rect.height !== s.h || (s.el.dataset.focus ?? '') !== s.focus) {
        s.w = rect.width
        s.h = rect.height
        fit(s)
      }
      if (running) {
        if (s.pendingMove) {
          s.inst.pointer?.(s.pendingMove)
          s.pendingMove = null
        }
        for (const p of s.queue) s.inst.pointer?.(p)
        s.queue.length = 0
        const alpha = s.clock.advance(now, () => s.inst.step(DT))
        s.inst.frame(alpha)
        animating = true
      }
      else {
        s.clock.reset()
        s.inst.frame(1)
      }
      const bottom = vh - rect.bottom
      r.setViewport(rect.left, bottom, rect.width, rect.height)
      r.setScissor(rect.left, bottom, rect.width, rect.height)
      r.clearDepth()
      r.info.reset()
      r.render(s.inst.scene, s.inst.camera)
      s.calls = r.info.render.calls
      s.triangles = r.info.render.triangles
      if (!s.drawn) {
        s.drawn = true
        s.onFirstFrame()
      }
    }
    this.lastFrame = animating ? now : 0
    if (animating) this.kick()
  }
}

let stage: Stage | null = null
let disposeTimer: ReturnType<typeof setTimeout> | undefined

/** The page's stage, created on first use. Returns null when WebGL is unavailable. */
export function getStage(): Stage | null {
  clearTimeout(disposeTimer)
  if (stage) return stage
  try {
    stage = new Stage()
  }
  catch {
    return null
  }
  if (import.meta.dev) (window as any).__stage = stage
  return stage
}

/**
 * Called after a slot is removed. When the last slot goes (route change), the
 * renderer and its context are released, after a beat so a page transition
 * that unmounts one slot and mounts another reuses the same context.
 */
export function releaseStageIfIdle() {
  clearTimeout(disposeTimer)
  disposeTimer = setTimeout(() => {
    if (stage && stage.size === 0) {
      stage.dispose()
      stage = null
      if (import.meta.dev) delete (window as any).__stage
    }
  }, 1000)
}

export type { Stage }
