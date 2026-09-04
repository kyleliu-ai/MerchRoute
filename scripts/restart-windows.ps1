param(
  [switch]$ForceActiveDownloads,
  [switch]$ForceActiveWbPublishing
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeEnvFile=if($env:MERCHROUTE_ENV_FILE){$env:MERCHROUTE_ENV_FILE}elseif($env:MERCHROUTE_RUNTIME_ENV_FILE){$env:MERCHROUTE_RUNTIME_ENV_FILE}else{Join-Path $ProjectRoot '.env.runtime'}
function Get-RuntimeSetting([string]$Name){$value=[Environment]::GetEnvironmentVariable($Name,'Process');if($value){return $value.Trim()};if(Test-Path -LiteralPath $RuntimeEnvFile){$prefix="$Name=";$line=Get-Content -LiteralPath $RuntimeEnvFile|Where-Object{$_.StartsWith($prefix,[StringComparison]::Ordinal)}|Select-Object -First 1;if($line){return $line.Substring($prefix.Length).Trim()}};return ''}
$PortValue=Get-RuntimeSetting 'MERCHROUTE_PORT';if(-not $PortValue){$PortValue=Get-RuntimeSetting 'PORT'};if(-not $PortValue){$PortValue='43173'}
$Port=[int]$PortValue
if($Port -lt 1024 -or $Port -gt 49151 -or @(4183,4184,5173,5432,5678,8000) -contains $Port){throw 'MERCHROUTE_PORT is invalid or reserved'}
$ExpectedOrigin="http://127.0.0.1:$Port";$ConfiguredOrigin=Get-RuntimeSetting 'MERCHROUTE_RUNTIME_BASE_URL';if($ConfiguredOrigin -and $ConfiguredOrigin.TrimEnd('/') -ne $ExpectedOrigin){throw 'MERCHROUTE_RUNTIME_BASE_URL does not match MERCHROUTE_PORT'}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
  if ($process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'dist/index\.js') {
    throw "端口 $Port 不是预期 MerchRoute Node 服务，拒绝停止"
  }
  if (-not $ForceActiveDownloads) {
    $activeDownloads = @()
    try {
      foreach ($status in @('QUEUED', 'WAITING_RESOURCE', 'RUNNING')) {
        $result = Invoke-RestMethod -Uri ("http://127.0.0.1:$Port/api/v1/purchases?page=1&pageSize=10&status=$status") -TimeoutSec 5
        if ([int]$result.total -gt 0) {
          $activeDownloads += [pscustomobject]@{ status = $status; count = [int]$result.total }
        }
      }
    } catch {
      throw "无法核验活动下载任务，拒绝强制重启。确认风险后可使用 -ForceActiveDownloads：$($_.Exception.Message)"
    }
    if ($activeDownloads.Count -gt 0) {
      $summary = ($activeDownloads | ForEach-Object { "$($_.status)=$($_.count)" }) -join ', '
      throw "存在活动下载任务（$summary），拒绝强制重启。等待任务结束，或确认风险后使用 -ForceActiveDownloads。"
    }
  } else {
    Write-Warning '已显式允许在存在活动下载任务时强制重启；幂等工作流将使用原 downloadJobId 恢复核验。'
  }

  if (-not $ForceActiveWbPublishing) {
    $activeWbPublishing = @()
    try {
      $activeWbStates = @('CHECKING', 'INITIALIZING', 'GENERATING', 'SUBMITTING', 'QUEUED', 'RUNNING')
      foreach ($state in $activeWbStates) {
        $result = Invoke-RestMethod -Uri ("http://127.0.0.1:$Port/api/v1/wb/automation/jobs?page=1&pageSize=1&state=$state") -TimeoutSec 5
        if ([int]$result.total -gt 0) {
          $activeWbPublishing += [pscustomobject]@{ state = $state; count = [int]$result.total }
        }
      }
    } catch {
      throw "无法核验活动 WB 自动上品任务，拒绝重启。确认风险后可使用 -ForceActiveWbPublishing：$($_.Exception.Message)"
    }
    if ($activeWbPublishing.Count -gt 0) {
      $summary = ($activeWbPublishing | ForEach-Object { "$($_.state)=$($_.count)" }) -join ', '
      throw "存在活动 WB 自动上品任务（$summary），拒绝重启，以免中断平台请求或 PostgreSQL 状态回写。等待任务结束，或确认风险后使用 -ForceActiveWbPublishing。"
    }
  } else {
    Write-Warning '已显式允许在存在活动 WB 自动上品任务时强制重启；平台写入结果可能进入 UNKNOWN，必须先回读再恢复。'
  }

  Stop-Process -Id $listener.OwningProcess -Force
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  } while ($stillListening -and (Get-Date) -lt $deadline)
  if ($stillListening) { throw '旧 MerchRoute 服务未能在 15 秒内停止' }
}

$env:NO_OPEN_BROWSER = '1'
Start-Process -FilePath (Get-Command pwsh).Source `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-windows.ps1')) `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden

$health = $null
$deadline = (Get-Date).AddSeconds(45)
do {
  Start-Sleep -Milliseconds 500
  try { $health = Invoke-RestMethod -Uri ("http://127.0.0.1:$Port/api/v1/health") -TimeoutSec 2 }
  catch { $health = $null }
} while (-not $health -and (Get-Date) -lt $deadline)
if (-not $health) { throw 'MerchRoute 重启后健康检查超时' }

$newListener = Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -First 1
[pscustomobject]@{ pid = $newListener.OwningProcess; health = $health } | ConvertTo-Json -Depth 5
