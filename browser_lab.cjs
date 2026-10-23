#!/usr/bin/env node
'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { chromium, firefox, webkit } = require('playwright')
const { profiles, options, resolveTarget } = require('./lib/config.cjs')
const { createContext } = require('./lib/network.cjs')
const { attachMetrics } = require('./lib/metrics.cjs')

async function launchBrowser(config, profileName = 'desktop') {
  const requested = ['iphone', 'tablet'].includes(profileName) ? 'webkit' : config.browser
  const candidates = requested === 'auto' ? ['chrome', 'msedge', 'chromium'] : [requested]
  const errors = []
  for (const name of candidates) {
    try {
      const type = name === 'firefox' ? firefox : name === 'webkit' ? webkit : chromium
      const browser = await type.launch({ headless: !config.headed,
        ...(['chrome', 'msedge'].includes(name) ? { channel: name } : {}), timeout: 60000 })
      return { browser, name }
    } catch (error) { errors.push(`${name}: ${error.message.split('\n')[0]}`) }
  }
  throw Error(`Cannot launch ${requested}: ${errors.join('; ')}. Run: npx playwright install chromium firefox webkit`)
}

async function fetchJSON(url, payload, userAgent) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), ...(payload ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify(payload),
  } : {}) })
  if (!response.ok) throw Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

async function finishContext(context, tracing, mode, result, filename) {
  let saved = false
  try {
    if (tracing) {
      // Write before cleanup so a cleanup failure also retains a usable trace.
      await context.tracing.stop({ path: filename })
      saved = true
    }
  } catch (error) {
    result.status = 'failed'
    result.trace_error = error.message
    result.error = [result.error, `Trace capture failed: ${error.message}`].filter(Boolean).join('\n')
  }
  try { await context.close() }
  catch (error) {
    result.status = 'failed'
    result.error = [result.error, `Context cleanup failed: ${error.message}`].filter(Boolean).join('\n')
  }
  if (saved) {
    if (mode === 'on' || result.status === 'failed') {
      result.trace ||= filename
      ;(result.traces ||= []).push(filename)
    } else {
      try { await fs.unlink(filename) }
      catch (error) {
        result.status = 'failed'
        result.trace = filename
        result.traces = [filename]
        result.trace_error = `Cannot discard successful trace: ${error.message}`
        result.error = [result.error, result.trace_error].filter(Boolean).join('\n')
      }
    }
  }
}

async function runSession(browser, profileName, index, baseURL, output, runId, config = {}) {
  const target = config.target || resolveTarget({ port: 8765, targetURL: baseURL })
  if (!config.target) {
    Object.assign(target, require('./lib/config.cjs').bundled, { baseURL })
    target.routes = { ...target.routes, home: baseURL }
  }
  const journey = config.journey || 'browse'
  const virtualId = `browser-${runId}-${index}-${profileName}`
  const result = { virtualId, profile: profileName, journey, status: 'passed', actions: [],
    consoleErrors: [], engine: browser.browserType().name(), browser_version: browser.version(),
    documents: [], transitions: [] }
  if (journey === 'mobile-menu' && profileName === 'desktop') {
    return { ...result, status: 'skipped', reason: 'Mobile-menu journey requires a mobile/tablet profile' }
  }
  const traceMode = config.trace || 'retain-on-failure'
  const contexts = []
  let page, context, snapshot, userAgent = 'SyntheticBrowserLab/2.0'
  const receiver = config.receiverURL || new URL(baseURL).origin
  const url = key => new URL(target.routes[key], target.baseURL).href
  const selector = key => page.locator(target.selectors[key])
  const log = async action => {
    const pathname = /^https?:/.test(page.url()) ? new URL(page.url()).pathname.slice(0, 100) : '/'
    await fetchJSON(`${receiver}/lab/event`, { claimed_device: profileName === 'iphone' ? 'ios' : profileName,
      virtual_id: virtualId, sequence: result.actions.length + 1, action, page: pathname }, userAgent)
    result.actions.push({ action, path: pathname })
  }
  const newContext = async storageState => {
    context = await createContext(browser, profileName, target.baseURL, { ...config,
      ...(storageState && config.network === 'offline' ? { network: 'native' } : {}),
      allowedOrigins: target.allowedOrigins, storageState })
    const entry = { context, tracing: false }
    contexts.push(entry)
    if (traceMode !== 'off') {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
      entry.tracing = true
    }
    snapshot = await attachMetrics(context, result)
    page = await context.newPage()
    if (context.labConfigurePage) await context.labConfigurePage(page)
    page.on('pageerror', error => result.consoleErrors.push(error.message))
    page.on('response', response => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame() && response.status() >= 400) {
        result.navigation_error = `Navigation returned HTTP ${response.status()}: ${response.url()}`
      }
    })
    result.network ||= context.labNetwork
  }
  const ready = async () => {
    await page.waitForLoadState('load')
    if (result.navigation_error) throw Error(result.navigation_error)
    if (target.selectors.ready) await selector('ready').waitFor({ state: 'visible' })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    userAgent = await page.evaluate(() => navigator.userAgent)
    await snapshot(page)
  }
  const transition = async (action, operation, expectedURL) => {
    await snapshot(page)
    const from = page.url(), start = performance.now()
    const response = await operation()
    if (response && typeof response.status === 'function' && response.status() >= 400) throw Error(`Navigation returned HTTP ${response.status()}`)
    if (expectedURL) await page.waitForURL(expectedURL)
    await ready()
    result.transitions.push({ action, from, to: page.url(), duration_ms: performance.now() - start })
    await log(action)
  }
  const openMenu = async () => {
    if (!target.selectors.menu || !await selector('menu').isVisible()) return
    const expanded = await selector('menu').getAttribute('aria-expanded')
    const navigationVisible = target.selectors.navigation
      ? await selector('navigation').isVisible().catch(() => false)
      : false
    if (expanded !== 'true' && !navigationVisible) await selector('menu').click()
  }
  try {
    await newContext()
    if (config.network === 'offline') {
      let blocked = false
      try { await page.goto(url('home'), { waitUntil: 'domcontentloaded' }) } catch { blocked = true }
      if (!blocked) throw Error('Offline profile unexpectedly allowed navigation')
      result.offline_verified = true
      await log('offline-blocked')
      await context.setOffline(false)
      // Settle the browser's error document before measuring the recovery navigation.
      await page.goto('about:blank')
    }
    await transition('landing', () => page.goto(url('home'), { waitUntil: 'domcontentloaded' }), url('home'))
    if (journey === 'browse') {
      const playingText = target.expected?.playing || 'Playing'
      const stoppedText = target.expected?.stopped || 'Stopped'
      await selector('play').click()
      await selector('playerState').filter({ hasText: playingText }).waitFor()
      await log('mock-player-play')
      await selector('play').click()
      await selector('playerState').filter({ hasText: stoppedText }).waitFor()
      if (await selector('play').getAttribute('aria-pressed') !== 'false') throw Error('Mock player did not pause')
      await log('mock-player-pause')
      for (const key of ['shows', 'trending', 'videos']) {
        await openMenu()
        await transition(`view-${key}`, () => selector(key).click(), url(key))
      }
    } else if (journey === 'history') {
      await openMenu()
      await transition('history-shows', () => selector('shows').click(), url('shows'))
      await transition('history-back', () => page.goBack(), url('home'))
      await transition('history-forward', () => page.goForward(), url('shows'))
      await transition('history-reload', () => page.reload(), url('shows'))
    } else if (journey === 'mobile-menu') {
      if (!await selector('menu').isVisible()) throw Error('Mobile menu toggle is not visible')
      const initialExpanded = await selector('menu').getAttribute('aria-expanded')
      if (initialExpanded === 'true') throw Error('Mobile menu starts expanded')
      if (await selector('navigation').isVisible().catch(() => false)) throw Error('Mobile navigation starts visible')
      await selector('menu').click()
      if (initialExpanded !== null && await selector('menu').getAttribute('aria-expanded') !== 'true') {
        throw Error('Mobile menu failed to open')
      }
      await selector('navigation').waitFor({ state: 'visible' })
      await log('mobile-menu-open')
      await selector('menu').click()
      await selector('navigation').waitFor({ state: 'hidden' })
      await log('mobile-menu-close')
      await openMenu()
      await transition('mobile-menu-navigate', () => selector('shows').click(), url('shows'))
      const finalExpanded = await selector('menu').getAttribute('aria-expanded')
      if (finalExpanded !== null && finalExpanded !== 'false') throw Error('Mobile menu did not close after navigation')
      if (await selector('navigation').isVisible().catch(() => false)) throw Error('Mobile navigation remained visible after navigation')
    } else if (journey === 'returning') {
      const proof = randomUUID()
      await page.evaluate(value => {
        localStorage.setItem('lab-return-proof', value)
        sessionStorage.setItem('lab-return-proof', value)
        document.cookie = `lab-return-proof=${value}; path=/; SameSite=Lax`
      }, proof)
      const state = await context.storageState()
      await log('first-visit-saved')
      await snapshot(page)
      await page.close()
      await newContext(state)
      await transition('return-visit', () => page.goto(url('home')), url('home'))
      const restored = await page.evaluate(() => ({ local: localStorage.getItem('lab-return-proof'),
        session: sessionStorage.getItem('lab-return-proof'), cookie: document.cookie }))
      if (restored.local !== proof || !restored.cookie.split('; ').includes(`lab-return-proof=${proof}`) || restored.session !== null) {
        throw Error('Returning context did not restore cookies/local storage with fresh session storage')
      }
      result.returning_session = { cookies_restored: true, local_storage_restored: true, session_storage_fresh: true }
      await log('returning-session-verified')
    }
    const layout = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight },
      width: document.documentElement.scrollWidth,
      touch: navigator.maxTouchPoints > 0 || matchMedia('(any-pointer: coarse)').matches,
      maxTouchPoints: navigator.maxTouchPoints, coarsePointer: matchMedia('(any-pointer: coarse)').matches,
      userAgent: navigator.userAgent, deviceScaleFactor: devicePixelRatio }))
    if (layout.width > layout.viewport.width + 1) throw Error('Page overflows the device viewport')
    result.device = layout
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await log('scroll-page')
    result.screenshot = path.join(output, `${virtualId}.png`)
    await page.screenshot({ path: result.screenshot, fullPage: true })
    await log('screenshot')
    await snapshot(page)
    // Finalize page-lifetime Web Vitals before disposing the context.
    await page.goto('about:blank')
    if (result.consoleErrors.length) throw Error(`Page JavaScript errors: ${result.consoleErrors.join('; ')}`)
  } catch (error) {
    result.status = 'failed'
    result.error = error.message
    if (page && !page.isClosed()) {
      try {
        if (snapshot) await snapshot(page)
        result.screenshot = path.join(output, `${virtualId}-failed.png`)
        await page.screenshot({ path: result.screenshot, fullPage: true, timeout: 10000 })
      } catch { /* A closed/crashed page may not allow diagnostics. */ }
    }
  } finally {
    for (let i = contexts.length - 1; i >= 0; i--) {
      const entry = contexts[i]
      await finishContext(entry.context, entry.tracing, traceMode === 'retain-on-failure' ? 'on' : traceMode, result,
        path.join(output, `${virtualId}${i ? '-return' : ''}-trace.zip`))
    }
    if (traceMode === 'retain-on-failure' && result.status === 'passed' && result.traces) {
      for (const filename of result.traces) {
        try { await fs.unlink(filename) }
        catch (error) {
          result.status = 'failed'
          result.trace = filename
          result.trace_error = `Cannot discard successful trace: ${error.message}`
          result.error = [result.error, result.trace_error].filter(Boolean).join('\n')
        }
      }
      if (result.status === 'passed') { delete result.trace; delete result.traces }
    }
  }
  return result
}

async function runDashboard(browser, receiver, output, mode, timeout) {
  const context = await createContext(browser, 'desktop', receiver, { timeout })
  const result = { status: 'passed' }
  let tracing = false
  try {
    if (mode !== 'off') { await context.tracing.start({ screenshots: true, snapshots: true }); tracing = true }
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${receiver}/lab/dashboard`)
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Last updated'))
    if (errors.length) throw Error(`Dashboard JavaScript errors: ${errors.join('; ')}`)
    result.screenshot = path.join(output, 'dashboard.png')
    await page.screenshot({ path: result.screenshot, fullPage: true })
  } catch (error) { result.status = 'failed'; result.error = error.message }
  finally { await finishContext(context, tracing, mode, result, path.join(output, 'dashboard-trace.zip')) }
  return result
}

async function runLab(config) {
  const receiver = `http://127.0.0.1:${config.port}`
  let health
  try { health = await fetchJSON(`${receiver}/lab/health`) }
  catch (error) { throw Error(`Local receiver unavailable at ${receiver}. Run npm start. ${error.message}`) }
  if (health.ok !== true || health.synthetic_only !== true) throw Error('Expected the local synthetic lab receiver')
  const target = config.target || resolveTarget(config)
  const outputRoot = config.outputRoot || path.join(__dirname, 'artifacts')
  await fs.mkdir(outputRoot, { recursive: true })
  const output = await fs.mkdtemp(path.join(outputRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-'))
  const summary = { synthetic_only: true, runId: randomUUID().slice(0, 12), trace_mode: config.trace,
    target, started_at: new Date().toISOString(), status: 'passed', sessions: [], browsers: {}, output }
  const launched = new Map()
  try {
    const jobs = []
    for (const profile of config.profiles) {
      const key = ['iphone', 'tablet'].includes(profile) ? 'webkit' : config.browser
      if (!launched.has(key)) {
        try {
          const value = await launchBrowser(config, profile)
          launched.set(key, value)
          summary.browsers[value.name] = value.browser.version()
        } catch (error) { launched.set(key, { error: error.message }) }
      }
      for (const journey of config.journeys) for (const network of config.networks) jobs.push({ profile, journey, network, key })
    }
    summary.browser = Object.keys(summary.browsers).join(', ')
    summary.sessions = new Array(jobs.length)
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const index = next++, job = jobs[index], value = launched.get(job.key)
        if (value.error) {
          summary.sessions[index] = { ...job, status: 'failed', actions: [], error: value.error }
          continue
        }
        try {
          summary.sessions[index] = await runSession(value.browser, job.profile, index + 1, target.baseURL,
            output, summary.runId, { ...config, ...job, target, receiverURL: receiver })
        } catch (error) { summary.sessions[index] = { ...job, status: 'failed', actions: [], error: error.message } }
      }
    }
    await Promise.all(Array.from({ length: Math.min(config.concurrency || 4, jobs.length) }, worker))
    if (summary.sessions.some(s => s.status === 'failed')) summary.status = 'failed'
    summary.report = await fetchJSON(`${receiver}/lab/report`)
    const available = [...launched.values()].find(item => item.browser)
    if (available) {
      const dashboard = await runDashboard(available.browser, receiver, output, summary.trace_mode, config.timeout)
      summary.dashboard_screenshot = dashboard.screenshot
      if (dashboard.trace) summary.dashboard_trace = dashboard.trace
      if (dashboard.trace_error) summary.dashboard_trace_error = dashboard.trace_error
      if (dashboard.status === 'failed') { summary.status = 'failed'; summary.error = dashboard.error }
    }
  } catch (error) { summary.status = 'failed'; summary.error = error.message }
  finally {
    for (const value of launched.values()) if (value.browser) {
      try { await value.browser.close() }
      catch (error) { summary.status = 'failed'; summary.cleanup_error = error.message }
    }
    summary.finished_at = new Date().toISOString()
    await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  }
  console.log(`${summary.status === 'passed' ? 'Finished' : 'Failed'} ${summary.sessions.length} browser journeys (${summary.browser}).`)
  console.log(`Screenshots, metrics and JSON report: ${output}`)
  console.log(`Dashboard: ${receiver}/lab/dashboard`)
  if (summary.status !== 'passed') {
    const error = Error([summary.error, ...summary.sessions.filter(s => s.status === 'failed').map(s =>
      `${s.profile}/${s.journey}/${typeof s.network === 'string' ? s.network : s.network?.name}: ${s.error}`)].filter(Boolean).join('\n'))
    error.summary = summary
    throw error
  }
  return summary
}

async function main() {
  const config = options(process.argv.slice(2))
  if (config.help) {
    console.log('Usage: node browser_lab.cjs [options]\n' +
      '  --profiles desktop,android,iphone,tablet (1-8; repeats allowed)\n' +
      '  --browser auto|chrome|msedge|chromium|firefox|webkit [--headed]\n' +
      '  Auto: Chrome/Edge/Chromium for desktop/Android; WebKit for iPhone/iPad.\n' +
      '  --target URL | --config target.json (custom targets default to smoke)\n' +
      '  --journeys browse,history,mobile-menu,returning,smoke\n' +
      '  --networks native,fast-4g,slow-3g,offline\n' +
      '  --trace retain-on-failure|on|off (default: retain-on-failure)\n' +
      '  --port 8765 --output artifacts --timeout 30000 --concurrency 4\n' +
      '  Maximum 64 matrix sessions; desktop mobile-menu is explicitly skipped.')
    return
  }
  await runLab(config)
}

module.exports = { profiles, options, launchBrowser, createContext, runSession, runLab, finishContext }
if (require.main === module) main().catch(error => { console.error(`Browser lab failed: ${error.message}`); process.exitCode = 1 })
