'use strict'
const fs = require('node:fs')
const path = require('node:path')
const library = fs.readFileSync(path.join(path.dirname(require.resolve('web-vitals')), 'web-vitals.iife.js'), 'utf8')

function installMetrics() {
  if (window !== window.top || !/^https?:$/.test(location.protocol)) return
  const types = PerformanceObserver.supportedEntryTypes || []
  const vitals = {}
  for (const [name, type] of [['LCP', 'largest-contentful-paint'], ['CLS', 'layout-shift'], ['INP', 'event']]) {
    vitals[name] = { value: null, status: types.includes(type) ? 'no-data' : 'unsupported' }
  }
  const snapshot = () => {
    const nav = performance.getEntriesByType('navigation')[0]
    return { id: String(performance.timeOrigin), url: location.href,
      navigation: nav ? { type: nav.type, ttfb_ms: nav.responseStart - nav.startTime,
        dom_content_loaded_ms: nav.domContentLoadedEventEnd || null,
        load_ms: nav.loadEventEnd || null, duration_ms: nav.duration || null,
        transfer_bytes: nav.transferSize, redirect_ms: nav.redirectEnd - nav.redirectStart } : null,
      vitals: JSON.parse(JSON.stringify(vitals)) }
  }
  window.__labSnapshot = snapshot
  const emit = () => window.__labMetric(snapshot()).catch(() => {})
  for (const name of ['LCP', 'CLS', 'INP']) {
    webVitals[`on${name}`](metric => {
      vitals[name] = { value: metric.value, status: 'measured', rating: metric.rating, id: metric.id }
      emit()
    }, { reportAllChanges: true })
  }
  // Registered after web-vitals so its page-hide flush runs first.
  addEventListener('pagehide', emit)
}

async function attachMetrics(context, result) {
  result.documents ||= []
  const save = data => {
    const index = result.documents.findIndex(item => item.id === data.id)
    if (index < 0) result.documents.push(data)
    else result.documents[index] = data
  }
  await context.exposeBinding('__labMetric', (source, data) => save(data))
  await context.addInitScript({ content: `${library}\n;(${installMetrics.toString()})();` })
  return async page => {
    if (!page || page.isClosed() || !/^https?:/.test(page.url())) return
    try {
      const data = await page.evaluate(() => window.__labSnapshot?.())
      if (data) save(data)
    } catch (error) {
      // A departing document also flushes through the binding; its execution context can disappear here.
      if (!/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error
    }
  }
}

module.exports = { attachMetrics }
