// Renders the still posters each 3D slot shows before its first frame, and to
// reduced-motion, Save-Data and no-WebGL visitors.
//
//   npm run dev                      (in another terminal)
//   node scripts/render-poster.mjs [scene ...] [--base http://localhost:3000]
//
// Each scene is opened at /lab/<scene>?poster=1, which places it in its fixed
// poster pose on a transparent page and sets window.__posterReady after fonts
// and two drawn frames. The capture is lossless PNG; sharp then encodes AVIF
// and WebP into public/img/scenes/<scene>-<width>.<ext>.
//
// The homepage draws every scene full screen with a FOCUS box (see fit() in
// app/three/core/stage.ts), so each poster is rendered at the screen shape
// and with the focus box its chapter uses: 768 is the phone poster (portrait,
// the phone cast, the phone focus); 1440 and 2160 are desktop. Run it manually after a scene changes and
// commit the outputs -- it is not part of the build.
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import sharp from 'sharp'

// The chapters' boxes stop at the dock's top, as the page measures them (SceneChapter.vue): about
// 0.74 of a 16:10 desktop's height and about 0.4 of a phone's (above the dock and the pinned band).
const CHAPTER = { desktop: 16 / 10, focus: '0.44 1 0 0.74', phone: 430 / 932, phoneFocus: '0 1 0 0.4' }
const SCENES = {
  // The hero is the whole first screen with no focus box (the words are keep-out walls); on a
  // phone it stacks under the headline, sized to the mat (80vw tall).
  hero: { desktop: 16 / 10, focus: '', phone: 1 / 0.8, phoneFocus: '' },
  backwater: CHAPTER,
  workshop: CHAPTER,
  electronics: { ...CHAPTER, focus: '0 0.6 0 0.7' },
  noise: CHAPTER,
  machines: CHAPTER,
}
const WIDTHS = [768, 1440, 2160]
const PHONE_WIDTH = 430

const args = process.argv.slice(2)
const baseAt = args.indexOf('--base')
const base = baseAt === -1 ? 'http://localhost:3000' : args[baseAt + 1]
const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--base')
const names = only.length ? only : Object.keys(SCENES)

const CHROME = process.env.CHROME_PATH
  || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome')
const out = new URL('../public/img/scenes/', import.meta.url)
await mkdir(out, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
/** The hero's keep-out rects as the homepage publishes them at this viewport (dev: window.__heroKeepOut). */
async function heroKeepOut(vw, vh) {
  const page = await browser.newPage({ viewport: { width: vw, height: vh } })
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForFunction(() => (window.__heroKeepOut?.rects.length ?? 0) > 0, null, { timeout: 30000 })
  await page.waitForTimeout(800)
  const rects = await page.evaluate(() => window.__heroKeepOut.rects)
  await page.close()
  return rects.map(r => [r.x0, r.x1, r.y0, r.y1].map(v => v.toFixed(4)).join(',')).join(';')
}

for (const name of names) {
  const scene = SCENES[name]
  if (!scene) throw new Error(`unknown scene ${name}`)
  for (const w of WIDTHS) {
    const phone = w === 768
    const vw = phone ? PHONE_WIDTH : w
    const vh = Math.round(vw / (phone ? scene.phone : scene.desktop))
    const focus = phone ? scene.phoneFocus : scene.focus
    // The hero's robots keep out of the words: read the live homepage's
    // keep-out rects at this screen size and hand them to the lab.
    const keepout = name === 'hero' && !phone ? await heroKeepOut(vw, vh) : ''
    // The phone poster is laid out at a phone's width and rendered sharp at 768.
    const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: phone ? w / vw : 1 })
    await page.goto(`${base}/lab/${name}?poster=1${focus ? `&focus=${encodeURIComponent(focus)}` : ''}${keepout ? `&keepout=${encodeURIComponent(keepout)}` : ''}`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => window.__posterReady === true, null, { timeout: 60000 })
    const png = await page.screenshot({ omitBackground: true })
    await page.close()
    const img = sharp(png).resize({ width: w })
    await img.clone().avif({ quality: 55 }).toFile(fileURLToPath(new URL(`${name}-${w}.avif`, out)))
    await img.clone().webp({ quality: 80 }).toFile(fileURLToPath(new URL(`${name}-${w}.webp`, out)))
    console.log(`${name}-${w} (${vw}x${vh})`)
  }
}
await browser.close()
