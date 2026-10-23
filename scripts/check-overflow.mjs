// Text overflow check: loads the homepage and both form pages at a range of
// widths (phone to 4K TV) and reports any text that runs outside the box it sits
// in (a chapter panel, a stall, the hero words, a dock), outside its own block
// (a heading wider than its grid cell, which the outer boxes cannot see), or past
// the page edge, plus any horizontal page scroll.
//
//   npm run dev                      (in another terminal)
//   node scripts/check-overflow.mjs [--base http://localhost:3000]
//
// Text is measured per text node with a Range (an element's own box spans its
// container, so it would hide the overflow). Exit 1 on any finding.
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const baseAt = args.indexOf('--base')
const base = baseAt === -1 ? 'http://localhost:3000' : args[baseAt + 1]
const SIZES = [[320, 640], [375, 667], [390, 844], [414, 896], [768, 1024], [900, 700], [1024, 768], [1280, 800], [1366, 768], [1440, 900], [1920, 1080], [2560, 1080], [3840, 2160]]
const PAGES = ['/', '/interestform', '/volunteer']
const BOXES = '.chapter-panel, .stall-board, .hero-copy, .chapter-dock, .hero-under, .footer-container, .wrap'

const CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome')
const browser = await chromium.launch({ executablePath: CHROME, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
let failures = 0
for (const path of PAGES) for (const [w, h] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, reducedMotion: 'reduce' })
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const found = await page.evaluate((BOXES) => {
    const out = []
    const vw = document.documentElement.clientWidth
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${vw}`)
    const walker = document.createTreeWalker(document.querySelector('#main, #form-main') ?? document.body, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || !n.textContent?.trim()) continue
      if (el.closest('.visually-hidden, [aria-hidden="true"], .scene-slot')) continue
      const st = getComputedStyle(el)
      if (st.visibility === 'hidden' || st.display === 'none') continue
      range.selectNodeContents(n)
      const r = range.getBoundingClientRect()
      if (r.width < 1) continue
      // Its own block: the nearest non-inline ancestor (a grid cell's heading is one).
      let own = el
      // (display: contents has no box of its own: the phone hero's words block is one.)
      const boxless = e => /^(inline|contents)/.test(getComputedStyle(e).display)
      while (own && boxless(own)) own = own.parentElement
      if (own) {
        const b = own.getBoundingClientRect()
        if (r.right > b.right + 2 || r.left < b.left - 2) out.push(`"${n.textContent.trim().slice(0, 40)}" runs ${Math.round(Math.max(r.right - b.right, b.left - r.left))}px outside its own <${own.tagName.toLowerCase()}>`)
      }
      let box = el.closest(BOXES)
      if (box && getComputedStyle(box).display === 'contents') box = null
      // The aisle scrolls sideways by design: only its boards are boxes.
      const inAisle = el.closest('.aisle-track')
      if (box) {
        const b = box.getBoundingClientRect()
        if (r.right > b.right + 1 || r.left < b.left - 1) out.push(`"${n.textContent.trim().slice(0, 40)}" runs ${Math.round(Math.max(r.right - b.right, b.left - r.left))}px outside .${[...box.classList][0]}`)
      }
      if (!inAisle && (r.right > vw + 1 || r.left < -1)) out.push(`"${n.textContent.trim().slice(0, 40)}" runs off the page (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`)
    }
    return [...new Set(out)]
  }, BOXES)
  await page.close()
  console.log(`${path} ${w}x${h}: ${found.length ? 'FAIL' : 'ok'}`)
  for (const f of found) console.log(`  ${f}`)
  failures += found.length
}
await browser.close()
if (failures) {
  console.log(`\n${failures} overflow finding(s)`)
  process.exit(1)
}
console.log('\nNo text overflows at any width')
