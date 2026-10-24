// The phone story (SceneChapter.vue, <= 740px or a short touch screen): every
// chapter card pins below the drawing, is readable above the nav, moves the
// chapter to its own step, and "Read more" opens and closes; the drawing
// keeps most of the screen and the page stays short and never scrolls sideways.
//   npm run dev, then: node scripts/check-mobile-flow.mjs [http://localhost:3000]
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://localhost:3000'
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
await mkdir('artifacts', { recursive: true })
/** The 2026-10 phone layout ran to 32 screens at 390x844; the story is about 22 there, 24 at 320x640. */
const MAX_SCREENS = 25
try {
  for (const [width, height] of [[320, 640], [390, 844], [430, 932], [844, 390]]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(300)
    const tag = `${width}x${height}`
    const screens = await page.evaluate(() => document.documentElement.scrollHeight / innerHeight)
    if (height > width) assert.ok(screens <= MAX_SCREENS, `${tag}: page is ${screens.toFixed(1)} screens (max ${MAX_SCREENS})`)

    let cards = 0
    for (const id of ['kochi', 'workshop', 'bench', 'noise', 'countdown']) {
      const count = await page.locator(`#${id} .chapter-panel`).count()
      for (let i = 0; i < count; i++) {
        // Scroll so card i has just reached its pin: the chapter's top plus the cards (and gaps) before it.
        await page.evaluate(({ id, i }) => {
          const ch = document.querySelector(`#${id} .chapter`)
          const items = [...ch.querySelectorAll('.chapter-panel')]
          const gap = Number.parseFloat(getComputedStyle(items[0].parentElement).rowGap) || 0
          let y = ch.getBoundingClientRect().top + window.scrollY + 2
          for (let k = 0; k < i; k++) y += items[k].offsetHeight + gap
          window.scrollTo(0, y)
        }, { id, i })
        await page.waitForTimeout(80)
        const s = await page.evaluate(({ id, i }) => {
          const ch = document.querySelector(`#${id} .chapter`)
          const card = ch.querySelectorAll('.chapter-panel')[i]
          const stick = Number.parseFloat(ch.style.getPropertyValue('--stick'))
          const r = card.getBoundingClientRect()
          const navTop = document.querySelector('.rail-wrap').getBoundingClientRect().top
          // Every visible line of text in the card, last one included (screen-reader-only text is clipped away).
          let textBottom = r.top
          const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            if (walker.currentNode.parentElement.closest('.visually-hidden')) continue
            const range = document.createRange()
            range.selectNodeContents(walker.currentNode)
            for (const rect of range.getClientRects()) if (rect.height > 2 && rect.width > 1) textBottom = Math.max(textBottom, rect.bottom)
          }
          const focus = ch.querySelector('.scene-slot').dataset.focus.split(/\s+/).map(Number)
          return {
            pinned: Math.abs(r.top - stick) <= 3,
            readable: textBottom <= navTop,
            step: Number(ch.dataset.step),
            art: focus[3] - focus[2],
            name: card.textContent.trim().replace(/\s+/g, ' ').slice(0, 30),
          }
        }, { id, i })
        const what = `${tag} ${id} card ${i + 1} "${s.name}"`
        assert.ok(s.pinned, `${what}: pinned under the drawing`)
        assert.ok(s.readable, `${what}: every line clears the nav`)
        assert.equal(s.step, i, `${what}: the chapter is on this card's step`)
        assert.ok(s.art >= (height > width ? 0.45 : 0.35), `${what}: the drawing keeps the screen (${s.art.toFixed(2)})`)
        cards++
      }
    }

    // "Read more" (Kochi's figures card): opens over the drawing, fully on screen, and closes again.
    await page.evaluate(() => {
      const ch = document.querySelector('#kochi .chapter')
      const items = [...ch.querySelectorAll('.chapter-panel')]
      const gap = Number.parseFloat(getComputedStyle(items[0].parentElement).rowGap) || 0
      window.scrollTo(0, ch.getBoundingClientRect().top + window.scrollY + 2 + items[0].offsetHeight + gap)
    })
    await page.waitForTimeout(80)
    const toggle = page.locator('#kochi .chapter-panel').nth(1).locator('.read-more-toggle')
    assert.equal(await toggle.isVisible(), true, `${tag}: "Read more" is offered`)
    await toggle.click()
    await page.waitForTimeout(80)
    const open = await page.evaluate(() => {
      const card = document.querySelectorAll('#kochi .chapter-panel')[1]
      const body = card.querySelector('.read-more-body')
      const r = card.getBoundingClientRect()
      return { shown: body.getBoundingClientRect().height > 0, inView: r.top >= 0 && r.bottom <= innerHeight + 1, expanded: card.querySelector('.read-more-toggle').getAttribute('aria-expanded') }
    })
    assert.ok(open.shown && open.expanded === 'true', `${tag}: "Read more" shows the full text`)
    assert.ok(open.inView, `${tag}: the open card stays on screen`)
    await toggle.click()
    await page.waitForTimeout(80)
    assert.equal(await page.locator('#kochi .chapter-panel').nth(1).locator('.read-more-body').isVisible(), false, `${tag}: "Show less" folds it again`)

    // Domains: a sideways row on a phone, never pinned.
    const aisle = await page.evaluate(() => {
      const row = document.querySelector('#categories .stalls')
      return { pinned: document.querySelector('#categories .aisle').classList.contains('is-pinned'), scrolls: row.scrollWidth > row.clientWidth, meter: Boolean(document.querySelector('#categories .aisle-meter')) }
    })
    assert.ok(!aisle.pinned && aisle.scrolls && aisle.meter, `${tag}: Domains is a swiped row with its meter`)

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    assert.equal(overflow, false, `${tag}: no sideways page scroll`)
    await page.screenshot({ path: `artifacts/mobile-flow-${tag}.png` })
    console.log(`${tag}: ${cards} cards pinned, readable and on their step; ${screens.toFixed(1)} screens; read more, domains row, no overflow`)
    await page.close()
  }
} finally { await browser.close() }
