// Verify the production integration while intercepting all analytics requests.
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://127.0.0.1:3001'
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' })
  const requests = []
  await page.route('https://**.clarity.ms/**', route => {
    requests.push(route.request().url())
    return route.fulfill({ contentType: 'application/javascript', body: 'window.__clarityTestLoaded = true' })
  })
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__clarityTestLoaded, null, { timeout: 10000 })
  assert.deepEqual(requests, ['https://www.clarity.ms/tag/z2fgjxhxv5'])
  assert.equal(await page.locator('#microsoft-clarity').count(), 1)
  await page.goto(`${base}/admin/login`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3500)
  assert.equal(await page.locator('#microsoft-clarity').count(), 0, 'admin visits do not load Clarity')
  assert.equal(requests.length, 1, 'admin does not request the analytics script')
  console.log('Production Clarity: correct environment ID, one deferred tag, admin excluded; all remote requests intercepted')
} finally { await browser.close() }
