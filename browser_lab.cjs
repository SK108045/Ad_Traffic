#!/usr/bin/env node
/* Real Chromium interactions against the bundled LOCAL synthetic staging page.
 * No public URL input, ad network calls, stealth settings, or impression spoofing.
 */

'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { chromium, devices } = require('playwright')

const HOST = '127.0.0.1'
const profiles = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  android: { ...devices['Pixel 7'] },
  iphone: { ...devices['iPhone 13'] },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
}

function options(argv) {
  const config = { profiles: ['desktop', 'android', 'iphone', 'tablet'], port: 8765, headed: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--profiles') {
      config.profiles = (argv[++i] || '').split(',').map(s => s.trim().toLowerCase())
    } else if (flag === '--port') {
      config.port = Number(argv[++i])
    } else if (flag === '--headed') {
      config.headed = true
    } else {
      throw Error(`Unknown option: ${flag}. Available: --profiles, --port, --headed`)
    }
  }
  if (config.profiles.length < 1 || config.profiles.length > 8 ||
      config.profiles.some(p => !Object.hasOwn(profiles, p))) {
    throw Error('Choose 1–8 profiles: desktop, android, iphone, tablet (repeats allowed)')
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw Error('Port must be 1–65535')
  }
  return config
}

async function record(page, payload) {
  await page.evaluate(async event => {
    const response = await fetch('/lab/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
    if (!response.ok) throw Error(`Synthetic lab event failed: ${response.status}`)
  }, payload)
}

async function runSession(browser, profileName, index, baseUrl, output) {
  const context = await browser.newContext(profiles[profileName])
  // Prevent accidental calls to any external host (including real ad networks).
  await context.route('**/*', route => {
    try {
      const url = new URL(route.request().url())
      if (url.hostname === HOST && url.protocol === 'http:') return route.continue()
    } catch { /* Reject malformed or non-network URLs. */ }
    return route.abort('blockedbyclient')
  })
  const page = await context.newPage()
  const virtualId = `browser-${index}-${profileName}`
  const actions = []
  let sequence = 0
  const log = async action => {
    sequence++
    actions.push({ action, path: new URL(page.url()).pathname })
    await record(page, {
      claimed_device: profileName === 'iphone' ? 'ios' : profileName,
      virtual_id: virtualId,
      sequence,
      action,
      page: new URL(page.url()).pathname,
    })
  }

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.getByText('SYNTHETIC / NO ADS').waitFor()
    await log('landing')
    await page.locator('#tune-in').click()
    await page.locator('#player-state').getByText('Playing', { exact: false }).waitFor()
    await log('mock-player-play')
    await page.locator('#tune-in').click()
    await log('mock-player-pause')
    await page.locator('#schedule-link').click()
    await page.waitForURL('**/shows')
    await log('view-shows')
    await page.locator('nav a[href="/trending"]').click()
    await page.waitForURL('**/trending')
    await log('view-trending')
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await log('scroll-page')
    const screenshot = path.join(output, `${virtualId}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    await log('screenshot')
    return { virtualId, profile: profileName, actions, screenshot }
  } finally {
    await context.close()
  }
}

async function main() {
  const config = options(process.argv.slice(2))
  const baseUrl = `http://${HOST}:${config.port}`
  const response = await fetch(`${baseUrl}/lab/health`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok || !(await response.json()).synthetic_only) {
    throw Error('Expected the local synthetic lab receiver')
  }
  const output = path.join(__dirname, 'artifacts', new Date().toISOString().replace(/[:.]/g, '-'))
  await fs.mkdir(output, { recursive: true })

  let browser
  try {
    browser = await chromium.launch({ headless: !config.headed })
    const sessions = await Promise.all(config.profiles.map((profile, index) =>
      runSession(browser, profile, index + 1, baseUrl, output)))
    const report = await (await fetch(`${baseUrl}/lab/report`)).json()
    const summary = { synthetic_only: true, sessions, report }
    await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2))
    console.log(`Finished ${sessions.length} virtual browser sessions.`)
    console.log(`Screenshots + JSON report: ${output}`)
    console.log(`Dashboard: ${baseUrl}/lab/dashboard`)
  } finally {
    if (browser) await browser.close()
  }
}

main().catch(error => {
  console.error(`Browser lab failed: ${error.message}`)
  console.error('Ensure the local server is running and Playwright Chromium is installed.')
  process.exitCode = 1
})
