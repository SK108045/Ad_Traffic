param([switch]$DownloadChromium)
$ErrorActionPreference = 'Stop'

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $Executable $($Arguments -join ' ')" }
}

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
        Invoke-Checked -Executable 'python' -Arguments @('-m', 'venv', '.venv')
    }
    Invoke-Checked -Executable '.\.venv\Scripts\python.exe' -Arguments @('-m', 'pip', 'install', '--disable-pip-version-check', '--timeout', '120', '-r', 'requirements-dev.txt')
    Invoke-Checked -Executable 'npm.cmd' -Arguments @('ci', '--no-fund', '--no-audit')
    if ($DownloadChromium) {
        Invoke-Checked -Executable 'npx.cmd' -Arguments @('playwright', 'install', 'chromium')
    }
    & node scripts/check-browser.cjs
    if ($LASTEXITCODE -ne 0) {
        Invoke-Checked -Executable 'npx.cmd' -Arguments @('playwright', 'install', 'chromium')
        Invoke-Checked -Executable 'node' -Arguments @('scripts/check-browser.cjs')
    }
    Write-Host 'Setup complete. Start the receiver: npm.cmd start'
}
finally { Pop-Location }
