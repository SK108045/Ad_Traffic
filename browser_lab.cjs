#!/usr/bin/env node
/* Actual browser QA against the bundled local, advertising-free staging site. */
'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { chromium, devices } = require('playwright')

const HOST = '127.0.0.1'
const profiles = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  android: { ...devices['Pixel 7'] },
  iphone: { ...devices['iPhone 13'] },
  tablet: { ...devices['iPad Mini'] },
}

function options(argv) {
  const config = { profiles: Object.keys(profiles), port: 8765, headed: false, browser: 'auto' }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--headed') config.headed = true
    else if (flag === '--help' || flag === '-h') config.help = true
    else if (['--profiles', '--port', '--browser', '--output'].includes(flag)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw Error(`Missing value for ${flag}`)
      if (flag === '--profiles') config.profiles = value.split(',').map(s => s.trim().toLowerCase())
      if (flag === '--port') config.port = Number(value)
      if (flag === '--browser') config.browser = value.toLowerCase()
      if (flag === '--output') config.outputRoot = path.resolve(value)
    } else throw Error(`Unknown option: ${flag}. Use --help for usage.`)
  }
  if (config.profiles.length < 1 || config.profiles.length > 8 ||
      config.profiles.some(p => !Object.hasOwn(profiles, p))) {
    throw Error('Choose 1-8 profiles: desktop, android, iphone, tablet (repeats allowed)')
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw Error('Port must be 1-65535')
  }
  if (!['auto', 'chrome', 'msedge', 'chromium'].includes(config.browser)) {
    throw Error('Browser must be auto, chrome, msedge, or chromium')
  }
  return config
}

async function launchBrowser(config) {
  // Reuse installed browsers through supported channels, without copying binaries.
  const candidates = config.browser === 'auto' ? ['chrome', 'msedge', 'chromium'] : [config.browser]
  const errors = []
  for (const name of candidates) {
    try {
      const browser = await chromium.launch({
        headless: !config.headed,
        ...(name === 'chromium' ? {} : { channel: name }),
        timeout: 60000,
      })
      return { browser, name }
    } catch (error) {
      errors.push(`${name}: ${error.message.split('\n')[0]}`)
    }
  }
  throw Error(`Cannot launch a browser. ${errors.join('; ')}. ` +
    'Install Chrome/Edge, or run: npx playwright install chromium')
}

async function createContext(browser, profileName, baseUrl) {
  const context = await browser.newContext({ ...profiles[profileName], serviceWorkers: 'block' })
  const origin = new URL(baseUrl).origin
  await context.route('**/*', route => {
    try {
      if (new URL(route.request().url()).origin === origin) return route.continue()
    } catch { /* Reject malformed URLs. */ }
    return route.abort('blockedbyclient')
  })
  await context.routeWebSocket('**/*', socket => socket.close())
  context.setDefaultTimeout(30000)
  context.setDefaultNavigationTimeout(60000)
  return context
}

async function record(page, payload) {
  await page.evaluate(async event => {
    const response = await fetch('/lab/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
    })
    if (!response.ok) throw Error(`Synthetic lab event failed: ${response.status}`)
  }, payload)
}

async function runSession(browser, profileName, index, baseUrl, output, runId) {
  const virtualId = `browser-${runId}-${index}-${profileName}`
  const result = { virtualId, profile: profileName, status: 'passed', actions: [], consoleErrors: [] }
  let context, page
  const log = async action => {
    const pathname = new URL(page.url()).pathname
    await record(page, {
      claimed_device: profileName === 'iphone' ? 'ios' : profileName,
      virtual_id: virtualId, sequence: result.actions.length + 1, action, page: pathname,
    })
    result.actions.push({ action, path: pathname })
  }
  try {
    context = await createContext(browser, profileName, baseUrl)
    page = await context.newPage()
    page.on('pageerror', error => result.consoleErrors.push(error.message))
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.getByText('SYNTHETIC / NO ADS').waitFor()
    await log('landing')
    await page.locator('#tune-in').click()
    await page.locator('#player-state').getByText('Playing', { exact: false }).waitFor()
    await log('mock-player-play')
    await page.locator('#tune-in').click()
    await page.locator('#player-state').getByText('Stopped', { exact: false }).waitFor()
    if (await page.locator('#tune-in').getAttribute('aria-pressed') !== 'false') {
      throw Error('Mock player did not pause')
    }
    await log('mock-player-pause')
    await page.locator('#schedule-link').click()
    await page.waitForURL('**/shows')
    await page.getByRole('heading', { name: 'Daily shows', exact: true }).waitFor()
    await log('view-shows')
    await page.locator('nav a[href="/trending"]').click()
    await page.waitForURL('**/trending')
    await page.getByRole('heading', { name: 'Trending now', exact: true }).waitFor()
    await log('view-trending')
    await page.locator('nav a[href="/videos"]').click()
    await page.waitForURL('**/videos')
    await page.getByRole('heading', { name: 'RIENG TV', exact: true }).waitFor()
    await log('view-videos')
    const layout = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      width: document.documentElement.scrollWidth,
      touch: navigator.maxTouchPoints > 0,
      userAgent: navigator.userAgent,
      deviceScaleFactor: devicePixelRatio,
    }))
    if (layout.width > layout.viewport.width + 1) throw Error('Page overflows the device viewport')
    result.device = layout
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await log('scroll-page')
    result.screenshot = path.join(output, `${virtualId}.png`)
    await page.screenshot({ path: result.screenshot, fullPage: true })
    await log('screenshot')
    if (result.consoleErrors.length) throw Error(`Page JavaScript errors: ${result.consoleErrors.join('; ')}`)
  } catch (error) {
    result.status = 'failed'
    result.error = error.message
    if (page && !page.isClosed()) {
      const screenshot = path.join(output, `${virtualId}-failed.png`)
      try {
        await page.screenshot({ path: screenshot, fullPage: true, timeout: 10000 })
        result.screenshot = screenshot
      } catch { /* A closed/crashed page may not allow a screenshot. */ }
    }
  } finally {
    if (context) await context.close()
  }
  return result
}

async function fetchJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

async function runLab(config) {
  const baseUrl = `http://${HOST}:${config.port}`
  let health
  try { health = await fetchJSON(`${baseUrl}/lab/health`) }
  catch (error) { throw Error(`Local receiver unavailable at ${baseUrl}. Run npm start. ${error.message}`) }
  if (health.ok !== true || health.synthetic_only !== true) throw Error('Expected the local synthetic lab receiver')
  const outputRoot = config.outputRoot || path.join(__dirname, 'artifacts')
  await fs.mkdir(outputRoot, { recursive: true })
  const output = await fs.mkdtemp(path.join(outputRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-'))
  const summary = { synthetic_only: true, runId: randomUUID().slice(0, 12),
    started_at: new Date().toISOString(), status: 'passed', sessions: [], output }
  let browser
  try {
    const launched = await launchBrowser(config)
    browser = launched.browser
    summary.browser = launched.name
    summary.browser_version = browser.version()
    const settled = await Promise.allSettled(config.profiles.map((profile, index) =>
      runSession(browser, profile, index + 1, baseUrl, output, summary.runId)))
    summary.sessions = settled.map((result, index) => result.status === 'fulfilled' ? result.value :
      { profile: config.profiles[index], status: 'failed', error: result.reason.message, actions: [] })
    if (summary.sessions.some(session => session.status !== 'passed')) summary.status = 'failed'
    summary.report = await fetchJSON(`${baseUrl}/lab/report`)
    // The dashboard is also exercised in a real browser and saved for review.
    const context = await createContext(browser, 'desktop', baseUrl)
    try {
      const dashboard = await context.newPage()
      const errors = []
      dashboard.on('pageerror', error => errors.push(error.message))
      await dashboard.goto(`${baseUrl}/lab/dashboard`, { waitUntil: 'domcontentloaded' })
      await dashboard.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Last updated'))
      if (errors.length) throw Error(`Dashboard JavaScript errors: ${errors.join('; ')}`)
      summary.dashboard_screenshot = path.join(output, 'dashboard.png')
      await dashboard.screenshot({ path: summary.dashboard_screenshot, fullPage: true })
    } finally { await context.close() }
  } catch (error) {
    summary.status = 'failed'
    summary.error = error.message
  } finally {
    if (browser) await browser.close()
    summary.finished_at = new Date().toISOString()
    await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  }
  console.log(`${summary.status === 'passed' ? 'Finished' : 'Failed'} ${summary.sessions.length} virtual browser sessions (${summary.browser || config.browser}).`)
  console.log(`Screenshots + JSON report: ${output}`)
  console.log(`Dashboard: ${baseUrl}/lab/dashboard`)
  if (summary.status !== 'passed') {
    const failures = summary.sessions.filter(s => s.status === 'failed').map(s => `${s.profile}: ${s.error}`)
    throw Error([summary.error, ...failures].filter(Boolean).join('\n'))
  }
  return summary
}

async function main() {
  const config = options(process.argv.slice(2))
  if (config.help) {
    console.log('Usage: node browser_lab.cjs [--profiles desktop,android,iphone,tablet] [--port 8765]\n' +
      '  [--browser auto|chrome|msedge|chromium] [--headed] [--output artifacts]\n' +
      'Auto reuses installed Chrome, then Edge, then downloaded Playwright Chromium. Up to 8 profiles, repeats allowed.')
    return
  }
  await runLab(config)
}

module.exports = { profiles, options, launchBrowser, createContext, runSession, runLab }
if (require.main === module) main().catch(error => {
  console.error(`Browser lab failed: ${error.message}`)
  process.exitCode = 1
})
