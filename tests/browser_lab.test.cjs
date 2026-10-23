'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { python, root } = require('../scripts/python.cjs')
const { options, profiles, launchBrowser, createContext, runLab, runSession, finishContext } = require('../browser_lab.cjs')
const { createServer, request: httpRequest } = require('node:http')
const os = require('node:os')

test('CLI parses profiles, repeated sessions, browser selection and headed mode', () => {
  const config = options(['--profiles', 'ANDROID,desktop,android', '--browser', 'msedge', '--port', '1234', '--headed'])
  assert.deepEqual(config.profiles, ['android', 'desktop', 'android'])
  assert.equal(config.browser, 'msedge')
  assert.equal(config.port, 1234)
  assert.equal(config.headed, true)
  assert.deepEqual(options([]).profiles, Object.keys(profiles))
  assert.equal(options(['--help']).help, true)
})

test('CLI rejects missing arguments, invalid limits and unsupported browsers', () => {
  for (const args of [['--profiles'], ['--port'], ['--browser'], ['--port', '--headed'],
    ['--port', '0'], ['--port', '65536'], ['--port', '1.2'], ['--port', 'NaN'],
    ['--profiles', ''], ['--profiles', 'android,unknown'], ['--browser', 'unknown'],
    ['--unknown'], ['--profiles', Array(9).fill('desktop').join(',')]]) {
    assert.throws(() => options(args), undefined, args.join(' '))
  }
  assert.equal(options(['--profiles', Array(8).fill('desktop').join(',')]).profiles.length, 8)
})

test('target, matrix, engine, network and tracing configuration is validated', async () => {
  assert.deepEqual(options([]).journeys, ['browse', 'history', 'mobile-menu', 'returning'])
  assert.equal(options(['--profiles', 'desktop', '--browser', 'firefox']).browser, 'firefox')
  const custom = options(['--target', 'https://staging.example.test/app/'])
  assert.deepEqual(custom.journeys, ['smoke'])
  assert.equal(custom.target.baseURL, 'https://staging.example.test/app/')
  for (const mode of ['on', 'off', 'retain-on-failure']) assert.equal(options(['--trace', mode]).trace, mode)
  for (const args of [['--trace'], ['--trace', 'bad'], ['--networks', 'bad'], ['--journeys', 'bad'],
    ['--networks', 'native,native'], ['--journeys', 'smoke,smoke'], ['--timeout', 'NaN'],
    ['--timeout', '0'], ['--concurrency', '9'], ['--concurrency', '1.5'], ['--target', 'file:///tmp'],
    ['--target', 'https://user:password@example.test/'], ['--browser', 'firefox'],
    ['--browser', 'chromium'], ['--target', 'https://example.test', '--journeys', 'history'],
    ['--profiles', Array(8).fill('desktop').join(','), '--networks', 'native,fast-4g,slow-3g']]) {
    assert.throws(() => options(args), undefined, args.join(' '))
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-config-'))
  const file = path.join(temp, 'target.json')
  try {
    await fs.writeFile(file, JSON.stringify({ baseURL: 'http://127.0.0.1:9000/app/',
      allowedOrigins: ['https://assets.example.test'], routes: { home: './', shows: '/shows' }, selectors: { shows: 'a.shows' } }))
    const config = options(['--config', file, '--journeys', 'history'])
    assert.deepEqual(config.target.allowedOrigins, ['http://127.0.0.1:9000', 'https://assets.example.test'])
    assert.equal(config.target.routes.home, './')
    for (const value of [[], null, { baseURL: 'ftp://example.test' },
      { baseURL: 'https://example.test', allowedOrigins: ['https://other.test/path'] },
      { baseURL: 'https://example.test', routes: { home: 'https://other.test/' } },
      { baseURL: 'https://example.test', selectors: { ready: null } }]) {
      await fs.writeFile(file, JSON.stringify(value))
      assert.throws(() => options(['--config', file]))
    }
    await fs.writeFile(file, '{broken')
    assert.throws(() => options(['--config', file]))
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})

test('tracing and cleanup failures produce failed results and still close contexts', async () => {
  let closed = false
  const failedTrace = { tracing: { stop: async () => { throw Error('disk full') } }, close: async () => { closed = true } }
  const result = { status: 'passed' }
  await finishContext(failedTrace, true, 'on', result, 'unused.zip')
  assert.equal(closed, true)
  assert.equal(result.status, 'failed')
  assert.match(result.trace_error, /disk full/)
  assert.equal(result.trace, undefined)
  const cleanup = { status: 'passed' }
  await finishContext({ close: async () => { throw Error('cleanup failed') } }, false, 'off', cleanup, 'unused.zip')
  assert.equal(cleanup.status, 'failed')
  assert.match(cleanup.error, /cleanup failed/)
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

async function verifyTraceViewer(browser, trace) {
  // This test intentionally uses the pinned viewer server shipped with Playwright.
  const { startTraceViewerServer } = require('playwright-core/lib/coreBundle').server
  const server = await startTraceViewerServer({ host: '127.0.0.1', port: 0,
    allowedFileRoots: () => [path.dirname(trace)] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  try {
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    const traceURL = `file?path=${encodeURIComponent(trace)}`
    await page.goto(`${server.urlPrefix('precise')}/trace/index.html?trace=${encodeURIComponent(traceURL)}`)
    await page.getByRole('treeitem').first().waitFor({ timeout: 30000 })
    assert.ok(await page.getByRole('treeitem').count() > 0)
    await page.getByRole('treeitem').filter({ hasText: 'Screenshot' }).first().click()
    await page.waitForFunction(() => {
      const scan = doc => [...doc.querySelectorAll('iframe')].some(frame => {
        try {
          const child = frame.contentDocument
          return child && (child.body?.textContent.includes('SYNTHETIC / NO ADS') || scan(child))
        } catch { return false }
      })
      return scan(document)
    })
    assert.deepEqual(errors, [])
    await page.screenshot({ path: trace.replace(/\.zip$/, '-viewer.png'), fullPage: true })
  } finally { await context.close(); await server.stop() }
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
      first = await runLab(options(['--port', String(port), '--journeys', 'browse']))
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
        'desktop,android,iphone,tablet,desktop,android,iphone,tablet', '--journeys', 'browse']))
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

    await t.test('explicit asset origins are allowed while other origins remain blocked', async () => {
      const asset = createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
        response.end('allowed asset')
      })
      asset.listen(0, '127.0.0.1')
      await once(asset, 'listening')
      const assetOrigin = `http://127.0.0.1:${asset.address().port}`
      const context = await createContext(browser, 'desktop', base, { allowedOrigins: [base, assetOrigin] })
      try {
        const page = await context.newPage()
        await page.goto(base)
        assert.equal(await page.evaluate(async url => (await fetch(url)).text(), assetOrigin + '/asset'), 'allowed asset')
        assert.equal(await page.evaluate(async () => {
          try { await fetch('https://blocked.invalid/'); return false } catch { return true }
        }), true)
      } finally { await context.close(); await new Promise(resolve => asset.close(resolve)) }
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
        const summaryResponse = await fetch(base + run.summary_url)
        assert.equal(summaryResponse.status, 200)
        assert.deepEqual(await summaryResponse.json(), first)
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

    await t.test('all journeys exercise real WebKit, history, menus, returning storage and metrics', async () => {
      const upgraded = await runLab(options(['--port', String(port)]))
      assert.equal(upgraded.sessions.length, 16)
      assert.equal(upgraded.sessions.filter(s => s.status === 'passed').length, 15)
      assert.equal(upgraded.sessions.filter(s => s.status === 'skipped').length, 1)
      for (const session of upgraded.sessions.filter(s => s.status === 'passed')) {
        assert.equal(session.engine, ['iphone', 'tablet'].includes(session.profile) ? 'webkit' : 'chromium')
        assert.ok(session.documents.length >= 1)
        assert.ok(session.transitions.every(t => t.duration_ms > 0 && t.to.startsWith(base)))
        for (const doc of session.documents) {
          assert.ok(doc.navigation.ttfb_ms >= 0)
          assert.ok(doc.navigation.load_ms > 0)
          for (const name of ['LCP', 'CLS', 'INP']) {
            assert.ok(['measured', 'no-data', 'unsupported'].includes(doc.vitals[name].status))
            assert.equal(doc.vitals[name].status === 'measured', typeof doc.vitals[name].value === 'number')
          }
        }
        if (session.journey === 'history') {
          assert.deepEqual(session.transitions.map(t => t.action), ['landing', 'history-shows', 'history-back', 'history-forward', 'history-reload'])
        }
        if (session.journey === 'returning') {
          assert.deepEqual(session.returning_session, { cookies_restored: true, local_storage_restored: true, session_storage_fresh: true })
          assert.equal(session.documents.length, 2)
        }
        assert.equal(session.trace, undefined)
      }
      assert.equal((await fs.readdir(upgraded.output)).some(name => name.endsWith('.zip')), false)
      const browse = upgraded.sessions.find(s => s.profile === 'desktop' && s.journey === 'browse')
      assert.ok(browse.documents.some(d => d.vitals.LCP.status === 'measured'))
      assert.ok(browse.documents.some(d => d.vitals.CLS.status === 'measured'))
    })

    await t.test('Firefox desktop runs browse, history and returning journeys', async () => {
      const summary = await runLab(options(['--port', String(port), '--profiles', 'desktop', '--browser', 'firefox']))
      assert.ok(summary.sessions.filter(s => s.status === 'passed').every(s => s.engine === 'firefox'))
      assert.equal(summary.sessions.filter(s => s.status === 'passed').length, 3)
      assert.ok(summary.browsers.firefox)
    })

    await t.test('all three engines apply network profiles and verify offline recovery', async () => {
      for (const args of [['--profiles', 'desktop,iphone'], ['--profiles', 'desktop', '--browser', 'firefox']]) {
        const summary = await runLab(options(['--port', String(port), '--journeys', 'smoke',
          '--networks', 'native,fast-4g,slow-3g,offline', '--trace', 'on', ...args]))
        for (const session of summary.sessions) {
          assert.equal(session.status, 'passed')
          if (session.network.name === 'offline') assert.equal(session.offline_verified, true)
          else if (session.network.name !== 'native') {
            assert.equal(session.network.method, session.engine === 'chromium' ? 'chromium-cdp' : 'per-response-delay')
            assert.ok(session.transitions[0].duration_ms >= session.network.latency)
          }
        }
        for (const session of summary.sessions.filter(s => s.network.name === 'native')) {
          await verifyTraceViewer(browser, session.trace)
        }
      }
    })

    await t.test('a separate configured target receives no receiver telemetry requests', async () => {
      const requests = []
      const external = createServer((request, response) => {
        requests.push(request.url)
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end('<!doctype html><meta name="viewport" content="width=device-width"><main><h1>Separate target</h1><a data-shows href="/section/">Section</a></main>')
      })
      external.listen(0, '127.0.0.1')
      await once(external, 'listening')
      try {
        const target = `http://127.0.0.1:${external.address().port}/app/`
        const summary = await runLab(options(['--port', String(port), '--target', target, '--profiles', 'desktop']))
        assert.equal(summary.sessions[0].journey, 'smoke')
        assert.equal(summary.sessions[0].documents[0].url, target)
        assert.ok(requests.includes('/app/'))
        assert.ok(requests.every(url => !url.startsWith('/lab/')))
        assert.equal(summary.sessions[0].actions.length, 3)
        const configFile = path.join(temp, 'external-target.json')
        await fs.writeFile(configFile, JSON.stringify({ name: 'Independent target', baseURL: target,
          routes: { home: '/app/', shows: '/section/' }, selectors: { ready: 'main', shows: '[data-shows]' } }))
        const configured = await runLab(options(['--port', String(port), '--config', configFile,
          '--profiles', 'desktop', '--journeys', 'history,returning']))
        assert.equal(configured.sessions.length, 2)
        assert.equal(configured.sessions[0].transitions[2].to, target)
        assert.equal(configured.sessions[1].returning_session.cookies_restored, true)
        assert.ok(requests.includes('/section/'))
        assert.ok(requests.every(url => !url.startsWith('/lab/')))
      } finally { await new Promise(resolve => external.close(resolve)) }
    })

    await t.test('traces are retained on success, discarded when off, and downloadable without corruption', async () => {
      const summary = await runLab(options(['--port', String(port), '--profiles', 'desktop', '--journeys', 'smoke,returning', '--trace', 'on']))
      assert.equal(summary.sessions[1].traces.length, 2)
      assert.equal((await fs.readdir(summary.output)).filter(n => n.endsWith('.zip')).length, 4)
      const runs = (await json(base + '/lab/runs')).runs
      const run = runs.find(r => r.id === path.basename(summary.output))
      assert.equal(run.traces.length, 4)
      for (const trace of run.traces) {
        const response = await fetch(base + trace.url)
        assert.equal(response.headers.get('content-type'), 'application/zip')
        assert.match(response.headers.get('content-disposition'), /^attachment; filename=".*\.zip"$/)
        const bytes = Buffer.from(await response.arrayBuffer())
        assert.equal(bytes.subarray(0, 2).toString(), 'PK')
        assert.deepEqual(bytes, await fs.readFile(path.join(summary.output, decodeURIComponent(trace.url.split('/').at(-1)))))
      }
      const downloadContext = await createContext(browser, 'desktop', base)
      try {
        const page = await downloadContext.newPage()
        await page.goto(base + '/lab/dashboard')
        const traceLink = page.locator(`#runs a[href="${run.traces[0].url}"]`)
        await traceLink.waitFor()
        const [download] = await Promise.all([page.waitForEvent('download'), traceLink.click()])
        assert.ok(download.suggestedFilename().endsWith('.zip'))
        const original = path.join(summary.output, decodeURIComponent(run.traces[0].url.split('/').at(-1)))
        assert.deepEqual(await fs.readFile(await download.path()), await fs.readFile(original))
        await page.getByText('Journey results and performance', { exact: true }).first().click()
        assert.ok((await page.locator('#runs details').first().innerText()).includes('returning'))
      } finally { await downloadContext.close() }
      const off = await runLab(options(['--port', String(port), '--profiles', 'desktop', '--journeys', 'smoke', '--trace', 'off']))
      assert.equal(off.sessions[0].trace, undefined)
      assert.equal((await fs.readdir(off.output)).some(n => n.endsWith('.zip')), false)
      const failed = await runSession(browser, 'desktop', 1, base + '/missing', temp, 'traced-failure', { timeout: 1000 })
      assert.equal(failed.status, 'failed')
      assert.ok((await fs.stat(failed.trace)).size > 1000)
      const failedOff = await runSession(browser, 'desktop', 1, base + '/missing', temp, 'untraced-failure', { trace: 'off', timeout: 1000 })
      assert.equal(failedOff.trace, undefined)
      await verifyTraceViewer(browser, summary.sessions[0].trace)
    })

    await t.test('a failed dashboard retains its trace and a failed run summary', async () => {
      const proxy = createServer((incoming, outgoing) => {
        if (incoming.url === '/lab/dashboard') {
          outgoing.writeHead(503, { 'Content-Type': 'text/html' })
          outgoing.end('<p id="status">Dashboard unavailable</p>')
          return
        }
        const forwarded = httpRequest(base + incoming.url, { method: incoming.method, headers: incoming.headers }, response => {
          outgoing.writeHead(response.statusCode, response.headers)
          response.pipe(outgoing)
        })
        forwarded.on('error', error => outgoing.destroy(error))
        incoming.pipe(forwarded)
      })
      proxy.listen(0, '127.0.0.1')
      await once(proxy, 'listening')
      try {
        let failure
        try {
          await runLab(options(['--port', String(proxy.address().port), '--target', base,
            '--profiles', 'desktop', '--timeout', '1000']))
        } catch (error) { failure = error }
        assert.ok(failure?.summary)
        assert.equal(failure.summary.status, 'failed')
        assert.equal(failure.summary.sessions[0].status, 'passed')
        assert.equal(failure.summary.sessions[0].trace, undefined)
        assert.ok((await fs.stat(failure.summary.dashboard_trace)).size > 1000)
        assert.equal(JSON.parse(await fs.readFile(path.join(failure.summary.output, 'summary.json'))).status, 'failed')
      } finally { await new Promise(resolve => proxy.close(resolve)) }
    })
  } finally {
    if (browser) await browser.close()
    await stopServer(child)
  }
})
