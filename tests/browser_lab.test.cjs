'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { python, root } = require('../scripts/python.cjs')
const { options, profiles, launchBrowser, createContext, runLab } = require('../browser_lab.cjs')

test('CLI parses profiles, repeated sessions, browser selection and headed mode', () => {
  const config = options(['--profiles', 'ANDROID,iphone,android', '--browser', 'msedge', '--port', '1234', '--headed'])
  assert.deepEqual(config.profiles, ['android', 'iphone', 'android'])
  assert.equal(config.browser, 'msedge')
  assert.equal(config.port, 1234)
  assert.equal(config.headed, true)
  assert.deepEqual(options([]).profiles, Object.keys(profiles))
  assert.equal(options(['--help']).help, true)
})

test('CLI rejects missing arguments, invalid limits and unsupported browsers', () => {
  for (const args of [['--profiles'], ['--port'], ['--browser'], ['--port', '--headed'],
    ['--port', '0'], ['--port', '65536'], ['--port', '1.2'], ['--port', 'NaN'],
    ['--profiles', ''], ['--profiles', 'android,unknown'], ['--browser', 'firefox'],
    ['--unknown'], ['--profiles', Array(9).fill('desktop').join(',')]]) {
    assert.throws(() => options(args), undefined, args.join(' '))
  }
  assert.equal(options(['--profiles', Array(8).fill('desktop').join(',')]).profiles.length, 8)
})

async function startServer(log) {
  const child = spawn(python, ['-u', 'lab.py', 'serve', '--port', '0', '--event-log', log],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stderr.on('data', data => { errors += data })
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Receiver startup timeout: ${errors}`)), 20000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', code => { clearTimeout(timer); reject(Error(`Receiver exited ${code}: ${errors}`)) })
      child.stdout.on('data', data => {
        output += data
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/lab\/report/)
        if (match) { clearTimeout(timer); resolve(Number(match[1])) }
      })
    })
    return { child, port }
  } catch (error) { child.kill(); throw error }
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await exited
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200)
  return response.json()
}

test('real browser sessions, dashboard, artifacts, isolation and recovery', { timeout: 600000 }, async t => {
  const artifacts = path.join(root, 'artifacts')
  await fs.mkdir(artifacts, { recursive: true })
  const temp = await fs.mkdtemp(path.join(artifacts, 'test-support-'))
  const { child, port } = await startServer(path.join(temp, 'events.jsonl'))
  const base = `http://127.0.0.1:${port}`
  let browser
  try {
    let first
    await t.test('four profiles play, pause, navigate, scroll, log events and save PNGs', async () => {
      first = await runLab(options(['--port', String(port)]))
      assert.equal(first.status, 'passed')
      assert.equal(first.sessions.length, 4)
      assert.equal(first.report.total_events, 32)
      assert.equal(first.report.virtual_sessions, 4)
      assert.deepEqual(first.report.by_claimed_device, { desktop: 8, android: 8, ios: 8, tablet: 8 })
      assert.deepEqual(first.report.by_observed_ip, { '127.0.0.1': 32 })
      for (const session of first.sessions) {
        assert.equal(session.actions.length, 8)
        assert.deepEqual(session.consoleErrors, [])
        const bytes = await fs.readFile(session.screenshot)
        assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
        const width = bytes.readUInt32BE(16)
        assert.equal(width, Math.round(session.device.viewport.width * session.device.deviceScaleFactor))
        // A real desktop can have a touchscreen; mobile profiles must expose touch.
        assert.equal(typeof session.device.touch, 'boolean')
        if (session.profile !== 'desktop') assert.equal(session.device.touch, true)
        assert.equal(session.device.viewport.width, profiles[session.profile].viewport.width)
      }
      const saved = JSON.parse(await fs.readFile(path.join(first.output, 'summary.json'), 'utf8'))
      assert.deepEqual(saved, first)
      assert.ok((await fs.stat(first.dashboard_screenshot)).size > 1000)
    })

    await t.test('eight concurrent repeated profiles have unique identities across runs', async () => {
      const second = await runLab(options(['--port', String(port), '--profiles',
        'desktop,android,iphone,tablet,desktop,android,iphone,tablet']))
      assert.equal(second.sessions.length, 8)
      assert.equal(second.report.total_events, 96)
      assert.equal(second.report.virtual_sessions, 12)
      assert.equal(new Set([...first.sessions, ...second.sessions].map(s => s.virtualId)).size, 12)
    })

    browser = (await launchBrowser(options([]))).browser
    await t.test('cookies and local/session storage are isolated between contexts', async () => {
      const a = await createContext(browser, 'android', base)
      const b = await createContext(browser, 'android', base)
      try {
        const pageA = await a.newPage(), pageB = await b.newPage()
        await pageA.goto(base)
        await pageA.evaluate(() => {
          localStorage.setItem('session-proof', 'A')
          sessionStorage.setItem('session-proof', 'A')
          document.cookie = 'session-proof=A; path=/'
        })
        await pageB.goto(base)
        assert.deepEqual(await pageB.evaluate(() => [localStorage.getItem('session-proof'),
          sessionStorage.getItem('session-proof'), document.cookie]), [null, null, ''])
      } finally { await a.close(); await b.close() }
    })

    await t.test('requests to external hosts and other loopback ports are blocked', async () => {
      const context = await createContext(browser, 'desktop', base)
      try {
        const page = await context.newPage()
        await page.goto(base)
        for (const target of ['https://example.invalid/blocked', `http://127.0.0.1:${port === 65535 ? 1 : port + 1}/blocked`]) {
          assert.equal(await page.evaluate(async url => {
            try { await fetch(url); return false } catch { return true }
          }, target), true)
        }
        assert.equal((await page.goto(base + '/shows')).status(), 200)
      } finally { await context.close() }
    })

    await t.test('dashboard refreshes totals, safely renders events, downloads reports and recovers', async () => {
      const context = await createContext(browser, 'android', base)
      try {
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(base + '/lab/dashboard', { waitUntil: 'domcontentloaded' })
        await page.waitForFunction(() => document.querySelector('#events').textContent === '96')
        assert.equal(await page.locator('#sessions').textContent(), '12')
        assert.equal(await page.locator('#ips').textContent(), '1')
        assert.equal(await page.locator('#rows tr').count(), 10)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
        assert.ok(await page.locator('#runs a').count() >= 5)
        const response = await fetch(base + '/lab/event', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claimed_device: 'desktop', virtual_id: 'dashboard-test', sequence: 1,
            action: '<img src=x onerror=alert(1)>', page: '/test' }) })
        assert.equal(response.status, 201)
        await page.waitForFunction(() => document.querySelector('#events').textContent === '97')
        assert.equal(await page.locator('#rows img').count(), 0)
        assert.ok((await page.locator('#rows').textContent()).includes('<img src=x onerror=alert(1)>'))
        const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-report').click()])
        const downloaded = JSON.parse(await fs.readFile(await download.path(), 'utf8'))
        assert.deepEqual(downloaded, await json(base + '/lab/report'))
        await page.route('**/lab/report', route => route.fulfill({ status: 503, body: '{}' }))
        await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'error')
        await page.unroute('**/lab/report')
        await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'ok')
        await page.screenshot({ path: path.join(temp, 'dashboard-mobile.png'), fullPage: true })
        assert.deepEqual(errors, [])
        const runs = await json(base + '/lab/runs')
        const run = runs.runs.find(run => run.id === path.basename(first.output))
        assert.ok(run)
        assert.equal((await fetch(base + run.summary_url)).status, 200)
        for (const screenshot of run.screenshots) {
          const image = await fetch(base + screenshot.url)
          assert.equal(image.headers.get('content-type'), 'image/png')
          assert.ok((await image.arrayBuffer()).byteLength > 1000)
        }
      } finally { await context.close() }
    })

    await t.test('failed sessions retain diagnostics and screenshots', async () => {
      const { runSession } = require('../browser_lab.cjs')
      const output = await fs.mkdtemp(path.join(temp, 'failure-'))
      // A missing local route exercises a real failed navigation without external traffic.
      const result = await runSession(browser, 'desktop', 1, base + '/missing', output, 'failed-test')
      assert.equal(result.status, 'failed')
      assert.ok(result.error)
      assert.ok((await fs.stat(result.screenshot)).size > 1000)
    })

    await t.test('event log contains every accepted browser event', async () => {
      const events = (await fs.readFile(path.join(temp, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      const report = await json(base + '/lab/report')
      assert.equal(events.length, report.total_events)
      assert.equal(events.length, 97)
      assert.ok(events.every(e => e.synthetic && e.observed_ip === '127.0.0.1'))
    })
  } finally {
    if (browser) await browser.close()
    await stopServer(child)
  }
})
