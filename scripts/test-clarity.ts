import assert from 'node:assert/strict'

// Exercise the actual plugin with a fake browser; never contact analytics.
const g = globalThis as any
g.defineNuxtPlugin = (plugin: unknown) => plugin
const { default: install } = await import('../app/plugins/clarity.client')

function browser(projectId: string, path = '/') {
  const scripts: any[] = []
  const tasks: (() => void)[] = []
  const hooks: (() => void)[] = []
  g.useRuntimeConfig = () => ({ public: { clarityProjectId: projectId } })
  g.location = { pathname: path }
  g.window = { requestIdleCallback: (fn: () => void) => tasks.push(fn) }
  g.document = {
    getElementById: (id: string) => scripts.find(s => s.id === id),
    createElement: () => ({}),
    head: { appendChild: (script: unknown) => scripts.push(script) },
  }
  const timers = g.setTimeout
  g.setTimeout = (fn: () => void) => tasks.push(fn)
  const start = () => {
    install({ hook: (_: string, fn: () => void) => hooks.push(fn) } as never)
    hooks.splice(0).forEach(fn => fn())
  }
  const flush = () => { while (tasks.length) tasks.shift()!() }
  return { scripts, start, flush, restore: () => { g.setTimeout = timers } }
}

for (const [id, path] of [['', '/'], ['invalid/id', '/'], ['z2fgjxhxv5', '/admin'], ['z2fgjxhxv5', '/admin/login'], ['z2fgjxhxv5', '/lab/workshop']]) {
  const b = browser(id!, path!)
  try {
    b.start(); b.flush()
    assert.equal(b.scripts.length, 0, `tracking excluded for ${path} with ID ${id}`)
  } finally { b.restore() }
}
const b = browser('z2fgjxhxv5')
try {
  b.start()
  assert.equal(b.scripts.length, 0, 'does not load during hydration')
  b.flush()
  assert.equal(b.scripts.length, 1)
  assert.equal(b.scripts[0].src, 'https://www.clarity.ms/tag/z2fgjxhxv5')
  assert.equal(b.scripts[0].async, true)
  g.window.clarity('event', 'test-event')
  assert.deepEqual(g.window.clarity.q, [['event', 'test-event']], 'queues commands until the remote script arrives')
  b.start(); b.flush()
  assert.equal(b.scripts.length, 1, 'installs the tag only once')
} finally { b.restore() }
console.log('All Clarity configuration, exclusion, deferral and duplicate-install checks passed')
