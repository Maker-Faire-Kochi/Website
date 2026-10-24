// Check readable chapter flow at narrow phones, large phones and landscape.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://localhost:3000'
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
await mkdir('artifacts', { recursive: true })
try {
  for (const [width, height] of [[320, 640], [390, 844], [430, 932], [844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    const panels = page.locator('.chapter-panel')
    let checked = 0
    for (let i = 0; i < await panels.count(); i++) {
      // Bring the last line of each paragraph into the reading band. A long
      // sticky panel used to trap these lines below the bottom navigation.
      await panels.nth(i).evaluate(panel => {
        const chapter = panel.closest('.chapter')
        const stick = parseFloat(chapter.style.getPropertyValue('--stick'))
        const paragraph = panel.querySelector('p:last-child') || panel
        const range = document.createRange()
        range.selectNodeContents(paragraph)
        const lines = [...range.getClientRects()]
        const last = lines.at(-1)
        window.scrollBy(0, last.top - (stick + 24))
      })
      await page.waitForTimeout(40)
      const state = await panels.nth(i).evaluate(panel => {
        const chapter = panel.closest('.chapter')
        const stage = chapter.querySelector('.chapter-stage').getBoundingClientRect()
        const stick = parseFloat(chapter.style.getPropertyValue('--stick'))
        const bandTop = stage.top + stick
        const paragraph = panel.querySelector('p:last-child') || panel
        const range = document.createRange()
        range.selectNodeContents(paragraph)
        const line = [...range.getClientRects()].at(-1)
        const navTop = document.querySelector('.rail-wrap').getBoundingClientRect().top
        const focus = chapter.querySelector('.scene-slot').dataset.focus.split(/\s+/).map(Number)
        return {
          text: paragraph.textContent.trim().slice(0, 35),
          readable: line.top >= Math.max(0, bandTop) - 1 && line.bottom < navTop,
          artFraction: focus[3] - focus[2],
          naturalFlow: getComputedStyle(panel).position === 'relative',
          overflow: document.documentElement.scrollWidth > innerWidth,
        }
      })
      assert.equal(state.overflow, false, `${width}x${height}: no sideways page scroll`)
      assert.equal(state.naturalFlow, true, `${width}x${height}: text scrolls naturally`)
      assert.equal(state.readable, true, `${width}x${height}: last line readable for ${state.text}`)
      assert.ok(state.artFraction >= 0.27, `${width}x${height}: drawing has usable space (${state.artFraction})`)
      checked++
    }
    await page.locator('#kochi .chapter-panel').last().evaluate(panel => {
      const chapter = panel.closest('.chapter')
      const stick = parseFloat(chapter.style.getPropertyValue('--stick'))
      window.scrollBy(0, panel.getBoundingClientRect().top - stick)
    })
    await page.waitForTimeout(100)
    await page.screenshot({ path: `artifacts/mobile-flow-${width}x${height}.png` })
    console.log(`${width}x${height}: all ${checked} chapter panels readable, artwork preserved, no overflow`)
    await page.close()
  }
} finally { await browser.close() }
