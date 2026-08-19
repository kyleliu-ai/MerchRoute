$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

$RuntimeEnvFile = if ($env:MERCHROUTE_ENV_FILE) {
  $env:MERCHROUTE_ENV_FILE
} elseif ($env:MERCHROUTE_RUNTIME_ENV_FILE) {
  $env:MERCHROUTE_RUNTIME_ENV_FILE
} else {
  Join-Path $ProjectRoot '.env.runtime'
}
$env:MERCHROUTE_ENV_FILE = $RuntimeEnvFile
if (-not (Test-Path -LiteralPath $RuntimeEnvFile)) {
  throw "Missing $RuntimeEnvFile; MerchRoute runtime secrets are required."
}

foreach ($RuntimeVariable in @('MERCHROUTE_RUNTIME_KEY', 'MERCHROUTE_CREDENTIAL_ENCRYPTION_KEY')) {
  $Prefix = "$RuntimeVariable="
  $RuntimeLine = Get-Content -LiteralPath $RuntimeEnvFile |
    Where-Object { $_.StartsWith($Prefix, [System.StringComparison]::Ordinal) } |
    Select-Object -First 1
  if (-not $RuntimeLine -or -not $RuntimeLine.Substring($Prefix.Length).Trim()) {
    throw "$RuntimeVariable is missing from $RuntimeEnvFile."
  }
  [Environment]::SetEnvironmentVariable($RuntimeVariable, $RuntimeLine.Substring($Prefix.Length).Trim(), 'Process')
}

# The OZON multistore fleet switch is an optional, fail-closed runtime
# capability. Keep it beside the server-only runtime configuration, but never
# require it on installations that have not completed the controlled fleet
# deployment.
$FleetCapabilityVariable = 'MERCHROUTE_OZON_MULTISTORE_FLEET_READY'
$FleetCapabilityValue = [Environment]::GetEnvironmentVariable($FleetCapabilityVariable, 'Process')
if ([string]::IsNullOrWhiteSpace($FleetCapabilityValue)) {
  $FleetCapabilityPrefix = "$FleetCapabilityVariable="
  $FleetCapabilityLine = Get-Content -LiteralPath $RuntimeEnvFile |
    Where-Object { $_.StartsWith($FleetCapabilityPrefix, [System.StringComparison]::Ordinal) } |
    Select-Object -First 1
  if ($FleetCapabilityLine) {
    $FleetCapabilityValue = $FleetCapabilityLine.Substring($FleetCapabilityPrefix.Length).Trim()
  }
}
if (-not [string]::IsNullOrWhiteSpace($FleetCapabilityValue)) {
  if ($FleetCapabilityValue -notmatch '^(?:1|true|yes|on|0|false|no|off)$') {
    throw "$FleetCapabilityVariable must be a boolean value."
  }
  [Environment]::SetEnvironmentVariable($FleetCapabilityVariable, $FleetCapabilityValue, 'Process')
}

$Port = 4173
if ($env:PORT) {
  $ParsedPort = 0
  if (-not [int]::TryParse($env:PORT, [ref]$ParsedPort) -or $ParsedPort -lt 1 -or $ParsedPort -gt 65535) {
    Write-Host "PORT must be an integer between 1 and 65535. Current value: $($env:PORT)" -ForegroundColor Red
    exit 1
  }
  $Port = $ParsedPort
}

$Url = "http://127.0.0.1:$Port"
$HealthUrl = "$Url/api/v1/health"

function Open-ReviewCenter {
  param([int]$DelaySeconds = 0)
  if ($env:NO_OPEN_BROWSER -eq '1') { return }
  if ($DelaySeconds -gt 0) {
    Start-Job -ScriptBlock { param($Address, $Delay) Start-Sleep -Seconds $Delay; Start-Process $Address } -ArgumentList $Url, $DelaySeconds | Out-Null
    return
  }
  Start-Process $Url
}

function Get-ListeningProcess {
  try {
    $Connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    if (-not $Connection) { return $null }
    $Process = Get-Process -Id $Connection.OwningProcess -ErrorAction SilentlyContinue
    return [pscustomobject]@{
      Id = $Connection.OwningProcess
      ProcessName = if ($Process) { $Process.ProcessName } else { 'unknown process' }
    }
  } catch {
    return $null
  }
}

$ExistingHealth = $null
try {
  $ExistingHealth = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
} catch {
  $ExistingHealth = $null
}

if ($ExistingHealth -and $ExistingHealth.status -eq 'ok' -and $ExistingHealth.version -eq 'v003') {
  $ExistingProcess = Get-ListeningProcess
  $ProcessText = if ($ExistingProcess) { " PID $($ExistingProcess.Id)." } else { '' }
  Write-Host "MerchRoute is already running at $Url.$ProcessText Reusing the existing service." -ForegroundColor Green
  Open-ReviewCenter
  exit 0
}

$PortOwner = Get-ListeningProcess
if ($PortOwner) {
  Write-Host "Port $Port is already in use by $($PortOwner.ProcessName) (PID $($PortOwner.Id))." -ForegroundColor Red
  Write-Host "The process is not MerchRoute, or its health check failed. It was not stopped." -ForegroundColor Yellow
  Write-Host "Stop that process or set a different PORT, then run start-windows.cmd again." -ForegroundColor Yellow
  exit 1
}

# Windows PowerShell 5.1 reads UTF-8 files without BOM as an ANSI code page.
# Keep this launcher ASCII-only so it parses reliably on every Windows locale.
$ToolsRoot = Join-Path $ProjectRoot '.tools'
$BundledNode = Get-ChildItem -LiteralPath $ToolsRoot -Directory -Filter 'node-v22.23.1-win-x64' -ErrorAction SilentlyContinue |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'node.exe') } |
  Sort-Object Name -Descending |
  Select-Object -First 1

if ($BundledNode) {
  $env:Path = "$($BundledNode.FullName);$env:Path"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js was not found. Install Node.js 22.23.1.' -ForegroundColor Red
  exit 1
}

$NodeVersion = & node -p "process.versions.node"
if ($NodeVersion -ne '22.23.1') {
  Write-Host "Node.js $NodeVersion is active. This project requires Node.js 22.23.1." -ForegroundColor Red
  exit 1
}

$NpmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $NpmCommand) {
  Write-Host 'npm.cmd was not found next to the active Node.js runtime.' -ForegroundColor Red
  exit 1
}

$NpmVersion = & $NpmCommand.Source --version
if ($NpmVersion -ne '10.9.8') {
  Write-Host "npm $NpmVersion is active. This project requires npm 10.9.8." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
  Write-Host 'Dependencies are missing. Run npm ci in the project root first.' -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'apps\server\dist\index.js'))) {
  Write-Host 'Building the project for the first time...'
  & $NpmCommand.Source run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Open-ReviewCenter -DelaySeconds 2
Write-Host "Starting MerchRoute with Node.js $NodeVersion at $Url" -ForegroundColor Cyan
& $NpmCommand.Source start
exit $LASTEXITCODE
