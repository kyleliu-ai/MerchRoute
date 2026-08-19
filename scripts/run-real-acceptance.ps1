param([switch]$ConfirmN8nPaused, [string]$ResumePrefix = '')
$ErrorActionPreference = 'Stop'
if (-not $ConfirmN8nPaused) { throw '安全门禁：请先暂停 E001-E005 相关 n8n 定时工作流，再使用 -ConfirmN8nPaused。' }
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot
$env:APP_DATA_DIR = Join-Path $ProjectRoot 'acceptance-results\app-data'
$env:PORT = '4191'
$env:HOST = '127.0.0.1'
$Server = Start-Process -FilePath 'node' -ArgumentList 'apps/server/dist/index.js' -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
try {
  $Ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-RestMethod 'http://127.0.0.1:4191/api/v1/health' | Out-Null; $Ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $Ready) { throw '验收服务未能在 15 秒内启动。' }
  $Arguments = @('scripts/real-acceptance.mjs', '--confirm-n8n-paused', '--base-url', 'http://127.0.0.1:4191')
  if ($ResumePrefix) { $Arguments += @('--resume-prefix', $ResumePrefix) }
  & node @Arguments
  if ($LASTEXITCODE -ne 0) { throw "真实验收失败，Node.js 退出码：$LASTEXITCODE" }
} finally {
  if ($Server -and -not $Server.HasExited) { Stop-Process -Id $Server.Id -Force }
}
