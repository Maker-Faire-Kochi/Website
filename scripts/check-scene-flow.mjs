// Mobile loading, lazy scene builds and live tool-cycle regression.
// Run against npm run dev: node scripts/check-scene-flow.mjs
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

await mkdir('artifacts', { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const base = process.argv[2] || 'http://localhost:3000'
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.loader')).visibility === 'hidden', null, { timeout: 10000 })
  await page.waitForFunction(() => document.querySelector('[data-scene="hero"] .scene-poster.is-hidden'), null, { timeout: 30000 })
  const initial = await page.evaluate(() => ({
    scenes: window.__stage.stats().slots.map(s => s.scene),
    overflow: document.documentElement.scrollWidth > innerWidth,
    dpr: window.__stage.renderer.getPixelRatio(),
  }))
  assert.deepEqual(initial.scenes, ['hero'], 'distant scenes stay unbuilt at initial load')
  assert.equal(initial.overflow, false, 'phone layout fits the viewport')
  assert.ok(initial.dpr <= 1.5, 'phone canvas has a bounded pixel cost')
  await page.screenshot({ path: 'artifacts/mobile-flow.png' })

  for (const name of ['backwater', 'workshop', 'electronics', 'noise', 'machines']) {
    await page.locator(`[data-scene="${name}"]`).evaluate(el => window.scrollTo(0, scrollY + el.getBoundingClientRect().top))
    await page.waitForFunction(name => document.querySelector(`[data-scene="${name}"] .scene-poster.is-hidden`), name, { timeout: 45000 })
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} has no phone overflow`)
    if (name === 'backwater') {
      for (const progress of [0.5]) {
        await page.evaluate(progress => {
          const chapter = document.querySelector('#kochi .chapter')
          const last = chapter.querySelector('.chapter-panel:last-child')
          const padding = parseFloat(getComputedStyle(last.parentElement).paddingBottom)
          const anchor = parseFloat(chapter.style.getPropertyValue('--stick')) + last.offsetHeight
          const remaining = anchor + padding - progress * innerHeight * 0.8
          window.scrollBy(0, chapter.getBoundingClientRect().bottom - remaining)
        }, progress)
      }
      await page.waitForFunction(() => window.__backwaters[0].coconutPlayback.started, null, { timeout: 10000 })
      await page.evaluate(() => window.scrollBy(0, -80))
      await page.waitForFunction(() => window.__backwaters[0].coconutPlayback.progress === 1, null, { timeout: 10000 })
      assert.equal(await page.evaluate(() => window.__backwaters[0].coconutPlayback.started), true, 'drop finishes after scrolling back')
      await page.screenshot({ path: 'artifacts/coconut-scroll-mobile.png' })
    }
  }

  await page.goto(`${base}/lab/workshop`, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__workshops?.length > 0, null, { timeout: 30000 })
  const seen = new Set()
  const deadline = Date.now() + 45000
  while (seen.size < 3 && Date.now() < deadline) {
    const tool = await page.evaluate(() => window.__workshops[0]?.sim.timeline.current)
    if (tool) seen.add(tool)
    await page.waitForTimeout(250)
  }
  assert.deepEqual([...seen].sort(), ['chisel', 'plane', 'saw'], 'all workshop tools run in the live renderer')
  assert.deepEqual(errors, [], 'no browser runtime errors')
  console.log(JSON.stringify({ initial, liveTools: [...seen], runtimeErrors: errors.length }))
} finally {
  await browser.close()
}
