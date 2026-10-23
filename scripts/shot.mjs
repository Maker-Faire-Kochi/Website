// Screenshot a page in the locally installed Chrome (playwright-core, no browser download).
//
//   node scripts/shot.mjs <url> <out.png> [--w 1440] [--h 900] [--wait 1500] [--dpr 1]
//                         [--cpu 4] [--sample 3000] [--reduced] [--webgl-off]
//                         [--move x,y] [--tap x,y] [--scroll y]
//
// --sample N   after waiting, record stage stats for N ms and print them as JSON
//              (draw calls, triangles, frame-time p50/p95) -- the perf gates.
// --cpu N      Chrome CPU throttling rate during the sample (4 = the plan's mobile gate).
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const [url, out] = args
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [options]')
  process.exit(2)
}
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const flag = name => args.includes(`--${name}`)
const pair = s => s?.split(',').map(Number)

const CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome')

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    ...(flag('webgl-off') ? ['--disable-webgl', '--disable-3d-apis'] : []),
  ],
})
const page = await browser.newPage({
  viewport: { width: Number(opt('w', 1440)), height: Number(opt('h', 900)) },
  deviceScaleFactor: Number(opt('dpr', 1)),
  reducedMotion: flag('reduced') ? 'reduce' : 'no-preference',
})
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => m.type() === 'error' && errors.push(m.text()))

await page.goto(url, { waitUntil: 'networkidle' })
if (opt('scroll')) await page.evaluate(y => window.scrollTo(0, y), Number(opt('scroll')))
if (url.includes('poster=')) {
  await page.waitForFunction(() => window.__posterReady === true, null, { timeout: 30000 })
}
else {
  await page.waitForTimeout(Number(opt('wait', 1500)))
}
const move = pair(opt('move'))
if (move) {
  await page.mouse.move(move[0], move[1], { steps: 8 })
  await page.waitForTimeout(800)
}
const tap = pair(opt('tap'))
if (tap) {
  await page.mouse.click(tap[0], tap[1])
  await page.waitForTimeout(600)
}

const sample = Number(opt('sample', 0))
if (sample) {
  const cdp = await page.context().newCDPSession(page)
  const cpu = Number(opt('cpu', 1))
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
  const stats = await page.evaluate(async (ms) => {
    const t = []
    let last = performance.now()
    let max = { calls: 0, triangles: 0 }
    const end = last + ms
    await new Promise((resolve) => {
      const f = (now) => {
        t.push(now - last)
        last = now
        const s = window.__stage?.stats()
        if (s) max = { calls: Math.max(max.calls, s.calls), triangles: Math.max(max.triangles, s.triangles) }
        if (now < end) requestAnimationFrame(f)
        else resolve()
      }
      requestAnimationFrame(f)
    })
    t.sort((a, b) => a - b)
    const q = p => +t[Math.min(t.length - 1, Math.floor(t.length * p))].toFixed(2)
    return { frames: t.length, p50: q(0.5), p95: q(0.95), maxCalls: max.calls, maxTriangles: max.triangles, slots: window.__stage?.stats().slots }
  }, sample)
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  console.log(JSON.stringify({ cpu, ...stats }))
}

await page.screenshot({ path: out })
if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'))
await browser.close()
