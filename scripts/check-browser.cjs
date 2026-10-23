'use strict'
const { launchBrowser, options } = require('../browser_lab.cjs')
;(async () => {
  const { browser, name } = await launchBrowser(options([]))
  try { console.log(`Browser ready: ${name} ${browser.version()}`) }
  finally { await browser.close() }
})().catch(error => { console.error(error.message); process.exitCode = 1 })
