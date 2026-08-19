param(
  [switch]$ForceActiveDownloads
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Port = 4173
if ($env:PORT) { $Port = [int]$env:PORT }

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
