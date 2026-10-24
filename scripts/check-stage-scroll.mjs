// Keep the live drawing attached to the document even if JS misses scroll frames.
// node scripts/check-stage-scroll.mjs [http://127.0.0.1:3001]
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const base = process.argv[2] || 'http://127.0.0.1:3001'
try {
  for (const [width, height] of [[320, 640], [390, 844], [430, 932], [844, 390], [1440, 900]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 1000, hasTouch: width < 1000 })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    // Do not send synthetic verification visits to analytics.
    await page.route('https://**.clarity.ms/**', route => route.fulfill({ contentType: 'application/javascript', body: '' }))
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-scene="hero"] .scene-poster.is-hidden', { state: 'attached', timeout: 60000 })
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto'
      const slot = document.querySelector('[data-scene="hero"]')
      window.scrollTo(0, Math.max(0, scrollY + slot.getBoundingClientRect().top - 100))
    })
    await page.waitForTimeout(200)
    // A slow mobile frame leaves the previous raster on screen while the
    // compositor continues scrolling. Freeze rAF to reproduce that gap.
    await page.evaluate(() => { window.__nativeRAF = window.requestAnimationFrame; window.requestAnimationFrame = () => 0 })
    await page.waitForTimeout(100)
    const relativeTop = () => page.evaluate(() => document.querySelector('.mf-stage').getBoundingClientRect().top - document.querySelector('[data-scene="hero"]').getBoundingClientRect().top)
    const before = await relativeTop()
    for (const delta of [120, -80, 150, -190]) {
      await page.evaluate(delta => window.scrollBy(0, delta), delta)
      assert.ok(Math.abs(await relativeTop() - before) < 1, `${width}x${height}: canvas stays attached during a missed frame (${delta}px swipe)`)
    }
    await page.evaluate(() => { window.requestAnimationFrame = window.__nativeRAF; delete window.__nativeRAF; window.dispatchEvent(new Event('scroll')) })
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no sideways page overflow')
    assert.deepEqual(errors, [], 'no browser runtime errors')
    console.log(`${width}x${height}: live playground stays aligned through four scrolls while rendering is stalled`)
    await page.close()
  }
} finally { await browser.close() }
