$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'restart-windows.ps1'
$source = Get-Content -Raw -LiteralPath $scriptPath
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)

if ($parseErrors.Count -gt 0) {
  throw "restart-windows.ps1 语法错误：$($parseErrors[0].Message)"
}

$parameterNames = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
if ($parameterNames -notcontains 'ForceActiveWbPublishing') {
  throw '缺少 ForceActiveWbPublishing 显式强制开关'
}

$requiredStates = @('CHECKING', 'INITIALIZING', 'GENERATING', 'SUBMITTING', 'QUEUED', 'RUNNING')
foreach ($state in $requiredStates) {
  if ($source -notmatch "'$state'") {
    throw "WB 活动任务门禁缺少状态：$state"
  }
}

$guardIndex = $source.IndexOf('/api/v1/wb/automation/jobs', [System.StringComparison]::Ordinal)
$stopIndex = $source.IndexOf('Stop-Process', [System.StringComparison]::Ordinal)
if ($guardIndex -lt 0 -or $stopIndex -lt 0 -or $guardIndex -gt $stopIndex) {
  throw 'WB 活动任务门禁必须在停止 MerchRoute 服务之前执行'
}

foreach ($requiredText in @(
  '无法核验活动 WB 自动上品任务，拒绝重启',
  '存在活动 WB 自动上品任务',
  '平台写入结果可能进入 UNKNOWN，必须先回读再恢复'
)) {
  if (-not $source.Contains($requiredText)) {
    throw "WB 重启安全提示缺失：$requiredText"
  }
}

[pscustomobject]@{
  ok = $true
  script = $scriptPath
  forceSwitch = 'ForceActiveWbPublishing'
  guardedStates = $requiredStates
  guardRunsBeforeStop = $true
} | ConvertTo-Json -Depth 3
