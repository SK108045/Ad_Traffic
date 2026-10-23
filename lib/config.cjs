'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { devices } = require('playwright')

const profiles = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: false },
  android: { ...devices['Pixel 7'] },
  iphone: { ...devices['iPhone 13'] },
  tablet: { ...devices['iPad Mini'] },
}
const networks = {
  native: { latency: 0, download: 0, upload: 0 },
  'fast-4g': { latency: 40, download: 9_000_000 / 8, upload: 3_000_000 / 8 },
  'slow-3g': { latency: 400, download: 400_000 / 8, upload: 400_000 / 8 },
  offline: { offline: true, latency: 0, download: 0, upload: 0 },
}
const journeys = ['browse', 'history', 'mobile-menu', 'returning', 'smoke']
const bundled = {
  name: 'Bundled staging site',
  routes: { home: '/', shows: '/shows', trending: '/trending', videos: '/videos' },
  selectors: { ready: '.lab-badge', play: '#tune-in', playerState: '#player-state',
    menu: '#menu-toggle', navigation: '#site-nav', shows: '#schedule-link',
    trending: '#site-nav a[href="/trending"]', videos: '#site-nav a[href="/videos"]' },
}

function httpURL(value, label) {
  let url
  try { url = new URL(value) } catch { throw Error(`${label} must be an absolute HTTP(S) URL`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Error(`${label} must be HTTP(S) without embedded credentials`)
  }
  return url
}

function resolveTarget(config) {
  const receiver = `http://127.0.0.1:${config.port}`
  let file = {}
  if (config.configFile) {
    file = JSON.parse(fs.readFileSync(config.configFile, 'utf8'))
    if (!file || Array.isArray(file) || typeof file !== 'object') throw Error('Target config must be an object')
    if (!file.baseURL && !config.targetURL) throw Error('Target config requires baseURL')
  }
  const custom = Boolean(config.targetURL || config.configFile)
  const baseURL = httpURL(config.targetURL || file.baseURL || receiver, 'Target').href
  const allowedOrigins = file.allowedOrigins || []
  if (!Array.isArray(allowedOrigins)) throw Error('allowedOrigins must be an array')
  const origins = [...new Set([new URL(baseURL).origin, ...allowedOrigins.map(value => {
    const url = httpURL(value, 'Allowed origin')
    if (url.href !== `${url.origin}/`) throw Error('Allowed origins cannot include paths, queries or fragments')
    return url.origin
  })])]
  const target = { ...(custom ? { name: 'Configured target', routes: { home: baseURL }, selectors: {} } : bundled),
    ...file, baseURL, allowedOrigins: origins, custom }
  if (!target.routes || Array.isArray(target.routes) || typeof target.routes !== 'object' ||
      !target.selectors || Array.isArray(target.selectors) || typeof target.selectors !== 'object') {
    throw Error('routes and selectors must be objects')
  }
  for (const [key, value] of Object.entries(target.routes)) {
    if (typeof value !== 'string' || !value) throw Error(`Invalid route: ${key}`)
    const url = httpURL(new URL(value, baseURL).href, `Route ${key}`)
    if (!origins.includes(url.origin)) throw Error(`Route ${key} is outside allowedOrigins`)
  }
  for (const [key, value] of Object.entries(target.selectors)) {
    if (typeof value !== 'string' || !value.trim()) throw Error(`Invalid selector: ${key}`)
  }
  return target
}

function options(argv) {
  const config = { profiles: Object.keys(profiles), port: 8765, headed: false, browser: 'auto',
    trace: 'retain-on-failure', networks: ['native'], timeout: 30000, concurrency: 4 }
  const values = ['--profiles', '--port', '--browser', '--output', '--trace', '--target', '--config',
    '--journeys', '--networks', '--timeout', '--concurrency']
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--headed') config.headed = true
    else if (flag === '--help' || flag === '-h') config.help = true
    else if (values.includes(flag)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw Error(`Missing value for ${flag}`)
      const key = flag.slice(2)
      if (['profiles', 'journeys', 'networks'].includes(key)) config[key] = value.split(',').map(s => s.trim().toLowerCase())
      else if (['port', 'timeout', 'concurrency'].includes(key)) config[key] = Number(value)
      else if (key === 'output') config.outputRoot = path.resolve(value)
      else if (key === 'config') config.configFile = path.resolve(value)
      else if (key === 'target') config.targetURL = value
      else config[key] = value.toLowerCase()
    } else throw Error(`Unknown option: ${flag}. Use --help for usage.`)
  }
  if (config.profiles.length < 1 || config.profiles.length > 8 || config.profiles.some(p => !Object.hasOwn(profiles, p))) {
    throw Error('Choose 1-8 profiles: desktop, android, iphone, tablet (repeats allowed)')
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw Error('Port must be 1-65535')
  if (!['auto', 'chrome', 'msedge', 'chromium', 'firefox', 'webkit'].includes(config.browser)) throw Error('Unknown browser')
  if (config.browser === 'firefox' && config.profiles.some(p => p !== 'desktop')) {
    throw Error('Firefox supports the desktop profile; use --profiles desktop --browser firefox')
  }
  if (['chrome', 'msedge', 'chromium', 'firefox'].includes(config.browser) && config.profiles.some(p => ['iphone', 'tablet'].includes(p))) {
    throw Error('iPhone/iPad profiles require WebKit; use --browser auto or webkit')
  }
  if (!['off', 'on', 'retain-on-failure'].includes(config.trace)) throw Error('Trace must be off, on, or retain-on-failure')
  if (!Number.isInteger(config.timeout) || config.timeout < 100 || config.timeout > 120000) throw Error('Timeout must be 100-120000 milliseconds')
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 8) throw Error('Concurrency must be 1-8')
  config.target = resolveTarget(config)
  config.journeys ||= config.target.custom ? ['smoke'] : ['browse', 'history', 'mobile-menu', 'returning']
  for (const [key, names] of [['journeys', journeys], ['networks', Object.keys(networks)]]) {
    if (!config[key].length || config[key].some(name => !names.includes(name)) || new Set(config[key]).size !== config[key].length) {
      throw Error(`Choose unique ${key} from: ${names.join(', ')}`)
    }
  }
  if (config.profiles.length * config.journeys.length * config.networks.length > 64) throw Error('Maximum 64 sessions per run; split the matrix into separate runs')
  for (const journey of config.journeys) {
    const selectors = journey === 'browse' ? ['play', 'playerState', 'shows', 'trending', 'videos'] :
      journey === 'history' ? ['shows'] : journey === 'mobile-menu' ? ['menu', 'navigation'] : []
    for (const key of selectors) if (!config.target.selectors[key]) throw Error(`${journey} requires selectors.${key} in target config`)
    const routes = journey === 'browse' ? ['home', 'shows', 'trending', 'videos'] :
      ['history', 'mobile-menu'].includes(journey) ? ['home', 'shows'] : ['home']
    for (const key of routes) if (!config.target.routes[key]) throw Error(`${journey} requires routes.${key} in target config`)
  }
  return config
}

module.exports = { profiles, networks, journeys, bundled, options, resolveTarget }
