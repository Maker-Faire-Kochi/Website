// Check alignment BEFORE the next render: compositor scrolling can move the
// page while JS is busy. Pinned drawings must stay still; the playground
// must travel with its text. Run with a local dev or preview server.
//   node scripts/check-scroll-anchor.mjs [http://localhost:3000]
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
try {
  for (const [width, height] of [[1440, 900], [390, 844], [844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 900, hasTouch: width < 900 })
    await page.goto(process.argv[2] || 'http://localhost:3000', { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    // Disable smooth scrolling and card settling to test exact deltas while a
    // visitor is actively touching the screen, before another frame can draw.
    await page.addStyleTag({ content: 'html { scroll-behavior: auto !important; }' })
    await page.evaluate(() => window.dispatchEvent(new Event('touchstart')))
    const tag = `${width}x${height}`
    await page.waitForSelector('[data-scene="hero"] .scene-poster.is-hidden', { state: 'attached' })
    await page.evaluate(() => window.scrollTo({ top: 40, behavior: 'instant' }))
    await page.waitForTimeout(100)
    const hero = await page.evaluate(() => {
      const canvas = document.querySelector('.mf-stage')
      const slot = document.querySelector('[data-scene="hero"]')
      const before = { canvas: canvas.getBoundingClientRect().top, slot: slot.getBoundingClientRect().top }
      window.scrollBy({ top: 40, behavior: 'instant' })
      return {
        canvasDelta: canvas.getBoundingClientRect().top - before.canvas,
        slotDelta: slot.getBoundingClientRect().top - before.slot,
      }
    })
    assert.equal(hero.slotDelta, -40, `${tag}: playground scrolls with the page`)
    assert.equal(hero.canvasDelta, hero.slotDelta, `${tag}: playground drawing stays with its text between frames`)

    for (const id of ['kochi', 'workshop', 'bench', 'noise', 'countdown']) {
      const chapter = page.locator(`#${id} .chapter-slot`)
      await page.evaluate(id => {
        const ch = document.querySelector(`#${id} .chapter`)
        window.scrollTo({ top: ch.getBoundingClientRect().top + window.scrollY + 120, behavior: 'instant' })
      }, id)
      await chapter.locator('.scene-poster.is-hidden').waitFor({ state: 'attached', timeout: 30000 })
      await page.waitForFunction(() => document.querySelector('.mf-stage')?.style.position === 'fixed')
      for (const delta of [40, -40]) {
        const alignment = await page.evaluate(({ id, delta }) => {
          const canvas = document.querySelector('.mf-stage')
          const slot = document.querySelector(`#${id} .chapter-slot`)
          window.scrollBy({ top: delta, behavior: 'instant' })
          return { canvas: canvas.getBoundingClientRect().top, slot: slot.getBoundingClientRect().top }
        }, { id, delta })
        assert.equal(alignment.slot, 0, `${tag} ${id}: slot remains pinned`)
        assert.equal(alignment.canvas, 0, `${tag} ${id}: drawing stays pinned between frames (${delta}px scroll)`)
        await page.waitForTimeout(80)
      }
    }
    // Returning to the hero must restore document scrolling after all chapters.
    await page.evaluate(() => window.scrollTo({ top: 40, behavior: 'instant' }))
    await page.waitForFunction(() => document.querySelector('.mf-stage')?.style.position === 'absolute')
    console.log(`${tag}: playground and all five pinned chapters stay aligned in both scroll directions`)
    await page.close()
  }
}
finally {
  await browser.close()
}
