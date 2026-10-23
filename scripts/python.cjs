'use strict'
const { existsSync } = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = path.join(__dirname, '..')
const venvPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const python = process.env.LAB_PYTHON || (existsSync(venvPython) ? venvPython : 'python')
module.exports = { python, root }
if (require.main === module) {
  const child = spawn(python, process.argv.slice(2), { cwd: root, stdio: 'inherit' })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
}
