import type { SceneFactory } from '../core/stage'

/**
 * Every scene is its own dynamic chunk, imported only when its slot nears the
 * viewport. Names are what <SceneSlot scene="..."> and /lab/<name> use.
 */
export const SCENES = {
  'kit': () => import('./kit-demo'),
  'balancer': () => import('../robots/balancer/lab'),
  'duck': () => import('../robots/duck/lab'),
  'hero': () => import('./hero'),
  'backwater': () => import('./backwater'),
  'workshop': () => import('./workshop'),
  'electronics': () => import('./electronics'),
  'noise': () => import('./noise'),
  'machines': () => import('./machines'),
  'people': () => import('../people/lab'),
  'dog': () => import('../robots/dog/lab'),
  'makey': () => import('../robots/makey/lab'),
} satisfies Record<string, () => Promise<{ default: SceneFactory }>>

export type SceneName = keyof typeof SCENES

export function isSceneName(name: string): name is SceneName {
  return name in SCENES
}
