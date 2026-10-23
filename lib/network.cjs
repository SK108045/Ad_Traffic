'use strict'
const { setTimeout: delay } = require('node:timers/promises')
const { profiles, networks } = require('./config.cjs')

async function createContext(browser, profileName, baseURL, config = {}) {
  const { defaultBrowserType, ...device } = profiles[profileName]
  const engine = browser.browserType().name()
  const networkName = config.network || 'native'
  const network = networks[networkName]
  if (!network) throw Error(`Unknown network: ${networkName}`)
  const origins = new Set(config.allowedOrigins || [new URL(baseURL).origin])
  const context = await browser.newContext({ ...device, serviceWorkers: 'block',
    ...(config.storageState ? { storageState: config.storageState } : {}) })
  try {
    await context.route('**/*', async route => {
      try {
        if (!origins.has(new URL(route.request().url()).origin)) return await route.abort('blockedbyclient')
        if (engine === 'chromium' || networkName === 'native' || network.offline) return await route.continue()
        // Portable fallback: latency/transfer delay per response, not link shaping.
        const uploadBytes = route.request().postDataBuffer()?.length || 0
        await delay(network.latency + uploadBytes / network.upload * 1000)
        const response = await route.fetch({ maxRedirects: 0, timeout: config.timeout || 30000 })
        const body = await response.body()
        const location = response.headers().location
        if (location && !origins.has(new URL(location, route.request().url()).origin)) return await route.abort('blockedbyclient')
        await delay(body.length / network.download * 1000)
        await route.fulfill({ response, body })
      } catch {
        try { await route.abort('failed') } catch { /* Already handled/closed. */ }
      }
    })
    await context.routeWebSocket('**/*', socket => socket.close())
    context.setDefaultTimeout(config.timeout || 30000)
    context.setDefaultNavigationTimeout(config.timeout || 30000)
    if (network.offline) await context.setOffline(true)
    if (engine === 'chromium' && !['native', 'offline'].includes(networkName)) {
      context.labConfigurePage = async page => {
        const cdp = await context.newCDPSession(page)
        await cdp.send('Network.enable')
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: network.latency,
          downloadThroughput: network.download, uploadThroughput: network.upload })
      }
    }
    context.labNetwork = { name: networkName, ...network,
      method: network.offline ? 'offline-with-online-recovery' : networkName === 'native' ? 'unthrottled' :
        engine === 'chromium' ? 'chromium-cdp' : 'per-response-delay' }
    return context
  } catch (error) { await context.close(); throw error }
}

module.exports = { createContext }
