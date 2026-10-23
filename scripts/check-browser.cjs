'use strict'
const { launchBrowser, options } = require('../browser_lab.cjs')
;(async () => {
  const requests = process.argv.includes('--chromium-only') ? [['auto', 'desktop']] :
    [['auto', 'desktop'], ['firefox', 'desktop'], ['webkit', 'iphone'], ['webkit', 'tablet']]
  let failures = 0
  for (const [engine, profile] of requests) {
    try {
      const config = options(['--browser', engine, '--profiles', profile])
      const { browser, name } = await launchBrowser(config, profile)
      try {
        const { defaultBrowserType, ...device } = require('../browser_lab.cjs').profiles[profile]
        const context = await browser.newContext(device)
        const page = await context.newPage()
        await page.setContent('<h1>Browser ready</h1>')
        await page.getByRole('heading', { name: 'Browser ready' }).waitFor()
        await context.close()
        console.log(`Browser ready: ${name} ${browser.version()} / ${profile}`)
      } finally { await browser.close() }
    } catch (error) { failures++; console.error(error.message) }
  }
  if (failures) process.exitCode = 1
})().catch(error => { console.error(error.message); process.exitCode = 1 })
