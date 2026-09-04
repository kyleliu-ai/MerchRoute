[CmdletBinding()]
param(
  [switch]$SkipPrerequisites,
  [switch]$DryRun,
  [string]$AppHome = (Join-Path $env:LOCALAPPDATA 'MerchRoute'),
  [string]$DataRoot = ''
)

$env:MERCHROUTE_APP_HOME = $AppHome
if ($DataRoot) { $env:MERCHROUTE_DATA_ROOT = $DataRoot }

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location -LiteralPath $ProjectRoot

function Require-Success([string]$Name) {
  if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

function Ensure-WingetPackage([string]$Id, [string]$Command, [string]$Version = '') {
  if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw 'winget.exe is required for automatic prerequisite installation.' }
  $Arguments = @('install', '--id', $Id, '--exact', '--accept-package-agreements', '--accept-source-agreements', '--silent')
  if ($Version) { $Arguments += @('--version', $Version) }
  & winget.exe @Arguments
  Require-Success "winget $Id"
}

if ($DryRun) {
  $DryRunNode = (Get-Command node.exe -ErrorAction Stop).Source
  & $DryRunNode deployment/scripts/bootstrap.mjs prepare "--app-home=$AppHome" '--dry-run'
  Require-Success 'deployment prepare dry-run'
  & $DryRunNode deployment/scripts/preflight.mjs '--dry-run'
  Require-Success 'deployment preflight dry-run'
  exit 0
}

if (-not $SkipPrerequisites) {
  Ensure-WingetPackage 'Git.Git' 'git.exe'
  Ensure-WingetPackage 'Docker.DockerDesktop' 'docker.exe'
  Ensure-WingetPackage 'OpenJS.NodeJS' 'node.exe' '22.23.1'
  if (-not (Test-Path -LiteralPath "$env:ProgramFiles\Google\Chrome\Application\chrome.exe")) {
    & winget.exe install --id 'Google.Chrome' --exact --accept-package-agreements --accept-source-agreements --silent
    Require-Success 'winget Google.Chrome'
  }
  Ensure-WingetPackage 'Gyan.FFmpeg' 'ffmpeg.exe'
  $env:PATH = [Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH', 'User')
}

$Node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $Node -and (Test-Path -LiteralPath "$env:ProgramFiles\nodejs\node.exe")) { $Node = "$env:ProgramFiles\nodejs\node.exe" }
if (-not $Node) { throw 'Node.js 22.23.1 was not found after installation.' }
$NodeVersion = & $Node -p 'process.versions.node'
if ($NodeVersion -ne '22.23.1') { throw "Node.js 22.23.1 is required; found $NodeVersion" }
$Npm = Join-Path (Split-Path -Parent $Node) 'npm.cmd'
if (-not (Test-Path -LiteralPath $Npm)) { $Npm = (Get-Command npm.cmd -ErrorAction Stop).Source }
$NpmVersion = & $Npm --version
if ($NpmVersion -ne '10.9.8') { & $Npm install --global npm@10.9.8; Require-Success 'npm pin'; $NpmVersion = & $Npm --version }
if ($NpmVersion -ne '10.9.8') { throw "npm 10.9.8 is required; found $NpmVersion" }
& $Node deployment/scripts/preflight.mjs
Require-Success 'deployment preflight'

$GlobalPrefix = Join-Path $env:APPDATA 'npm'
& $Npm install --global --prefix $GlobalPrefix n8n@2.32.6
Require-Success 'global n8n install'
$env:N8N_COMMAND = Join-Path $GlobalPrefix 'n8n.cmd'
if ((& $env:N8N_COMMAND --version) -ne '2.32.6') { throw 'n8n 2.32.6 version readback failed.' }

$PrepareArgs = @('deployment/scripts/bootstrap.mjs', 'prepare', "--app-home=$AppHome")
if ($DataRoot) { $PrepareArgs += "--data-root=$DataRoot" }
& $Node @PrepareArgs
Require-Success 'deployment prepare'

$SecretsDir = Join-Path $AppHome 'secrets'
$DeploymentEnv = Join-Path $SecretsDir 'deployment.env'
$N8nUserFolder = Join-Path $AppHome 'n8n\.n8n\nodes'
New-Item -ItemType Directory -Path $N8nUserFolder -Force | Out-Null
& $Npm install --prefix $N8nUserFolder n8n-nodes-globals@1.1.0
Require-Success 'n8n community node install'
$N8nRuntimeScripts = Join-Path $AppHome 'n8n-runtime\scripts'
& $Npm ci --prefix $N8nRuntimeScripts
Require-Success 'n8n runtime scripts npm ci'

& $Node deployment/scripts/bootstrap.mjs browser-profiles "--app-home=$AppHome"
Require-Success 'PDD and 1688 dedicated Chrome profile initialization'
& $Node deployment/scripts/bootstrap.mjs verify-browser-profiles "--app-home=$AppHome"
Require-Success 'PDD and 1688 headless Chrome profile reuse verification'

if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
  $DockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (-not (Test-Path -LiteralPath $DockerDesktop)) { throw 'Docker Desktop executable was not found.' }
  Start-Process -FilePath $DockerDesktop
}
for ($Attempt = 1; $Attempt -le 60; $Attempt += 1) {
  & docker info *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 5
}
& docker info *> $null
Require-Success 'Docker Desktop readiness'

& docker compose --env-file $DeploymentEnv -f deployment/postgres/compose.yaml up -d
Require-Success 'PostgreSQL start'
& docker compose -f integrations/jimeng-free-api-all/compose.yaml up -d --build
Require-Success 'Jimeng build and start'
& $Npm ci
Require-Success 'MerchRoute npm ci'
& $Npm run build
Require-Success 'MerchRoute build'

$LogDir = Join-Path $AppHome 'logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
Start-Process -FilePath $Node -ArgumentList 'deployment/scripts/start-merchroute.mjs' -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogDir 'merchroute.out.log') -RedirectStandardError (Join-Path $LogDir 'merchroute.err.log')
Start-Process -FilePath $Node -ArgumentList 'deployment/scripts/start-n8n.mjs' -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogDir 'n8n.out.log') -RedirectStandardError (Join-Path $LogDir 'n8n.err.log')

$MerchRoutePort=if($env:MERCHROUTE_PORT){[int]$env:MERCHROUTE_PORT}else{43173}
foreach ($Health in @(('http://127.0.0.1:'+$MerchRoutePort+'/api/v1/health'),'http://127.0.0.1:5678/healthz','http://127.0.0.1:8000/ping')) {
  $Ready = $false
  for ($Attempt = 1; $Attempt -le 60; $Attempt += 1) {
    try { $Response = Invoke-WebRequest -UseBasicParsing -Uri $Health -TimeoutSec 3; if ($Response.StatusCode -eq 200) { $Ready = $true; break } } catch {}
    Start-Sleep -Seconds 3
  }
  if (-not $Ready) { throw "Health check failed: $Health" }
}

& $Node deployment/scripts/bootstrap.mjs configure-merchroute "--app-home=$AppHome"
Require-Success 'MerchRoute E007 configuration and database projection'

Start-Process 'http://127.0.0.1:5678'
Read-Host 'Complete the local n8n owner setup in the browser, then press Enter'
$CredentialFile = Join-Path $SecretsDir 'credentials.local.json'
Start-Process notepad.exe -ArgumentList $CredentialFile -Wait
Read-Host 'Save the local credential file, close Notepad, then press Enter to validate and import'
& $Node deployment/scripts/bootstrap.mjs import-n8n "--app-home=$AppHome"
Require-Success 'n8n credential and workflow import'
& $Node deployment/scripts/bootstrap.mjs probe "--app-home=$AppHome" --allow-network-probes=true
Require-Success 'read-only credential probes'
& $Node deployment/scripts/bootstrap.mjs verify "--app-home=$AppHome"
Require-Success 'deployment verification'
Write-Host 'MerchRoute deployment completed. All 36 n8n workflows remain inactive.' -ForegroundColor Green
