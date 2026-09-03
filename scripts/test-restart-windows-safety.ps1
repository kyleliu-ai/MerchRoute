# All network, process and sleep commands below are replaced in the test scope.
# Never invoke the production restart script outside Invoke-MockedRestart.
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

# Fail closed if the target adds commands that this simulation has not reviewed.
# Module-qualified commands and dynamic invocation are deliberately not allowed:
# they could bypass the process/network mocks defined below.
$allowedCommands = @(
  'Split-Path', 'Get-NetTCPConnection', 'Select-Object', 'Get-CimInstance',
  'Invoke-RestMethod', 'ForEach-Object', 'Write-Warning', 'Stop-Process',
  'Get-Date', 'Start-Sleep', 'Start-Process', 'Get-Command', 'Join-Path', 'ConvertTo-Json'
)
foreach ($commandAst in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)) {
  if ($allowedCommands -notcontains $commandAst.GetCommandName()) {
    throw "未模拟的命令，拒绝执行重启测试：$($commandAst.Extent.Text)"
  }
}
if (@($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.ExitStatementAst] }, $true)).Count -gt 0) {
  throw '重启测试不允许目标脚本退出当前测试进程'
}

function Assert-RestartTest {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Invoke-MockedRestart {
  param(
    [string]$ActiveWbState = '',
    [string]$ActiveDownloadState = '',
    [ValidateSet('', 'wb', 'downloads')][string]$ApiFailure = '',
    [switch]$ForceDownloads,
    [switch]$ForceWb
  )
  $simulation = @{
    Phase = 'running'
    WbState = $ActiveWbState
    DownloadState = $ActiveDownloadState
    ApiFailure = $ApiFailure
    Events = [Collections.Generic.List[string]]::new()
    StopCount = 0
    StartCount = 0
    WbQueries = [Collections.Generic.List[string]]::new()
    DownloadQueries = [Collections.Generic.List[string]]::new()
  }

  function Get-NetTCPConnection {
    [CmdletBinding()]
    param([int]$LocalPort, [string]$State)
    if ($LocalPort -ne 49173 -or $State -ne 'Listen') { throw 'Unexpected simulated port lookup' }
    if ($simulation.Phase -eq 'running') { return [pscustomobject]@{ OwningProcess = 2147483000 } }
    if ($simulation.Phase -eq 'started') { return [pscustomobject]@{ OwningProcess = 2147483001 } }
  }
  function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    if ($ClassName -ne 'Win32_Process' -or $Filter -ne 'ProcessId=2147483000') { throw 'Unexpected simulated process lookup' }
    return [pscustomobject]@{ Name = 'node.exe'; CommandLine = 'node dist/index.js' }
  }
  function Invoke-RestMethod {
    [CmdletBinding()]
    param([string]$Uri, [int]$TimeoutSec)
    if ($Uri -match '^http://127\.0\.0\.1:49173/api/v1/purchases\?page=1&pageSize=10&status=([^&]+)$') {
      $requestedState = $Matches[1]
      $simulation.Events.Add("download:$requestedState")
      $simulation.DownloadQueries.Add($requestedState)
      if ($simulation.ApiFailure -eq 'downloads') { throw 'Simulated download API failure' }
      return [pscustomobject]@{ total = [int]($requestedState -eq $simulation.DownloadState) }
    }
    if ($Uri -match '^http://127\.0\.0\.1:49173/api/v1/wb/automation/jobs\?page=1&pageSize=1&state=([^&]+)$') {
      $requestedState = $Matches[1]
      $simulation.Events.Add("wb:$requestedState")
      $simulation.WbQueries.Add($requestedState)
      if ($simulation.ApiFailure -eq 'wb') { throw 'Simulated WB API failure' }
      return [pscustomobject]@{ total = [int]($requestedState -eq $simulation.WbState) }
    }
    if ($Uri -eq 'http://127.0.0.1:49173/api/v1/health' -and $simulation.Phase -eq 'started') {
      $simulation.Events.Add('health')
      return [pscustomobject]@{ status = 'ok'; version = 'mock-only' }
    }
    throw "Unexpected simulated API request: $Uri"
  }
  function Stop-Process {
    [CmdletBinding()]
    param([int]$Id, [switch]$Force)
    if ($Id -ne 2147483000 -or -not $Force -or $simulation.Phase -ne 'running') { throw 'Unexpected simulated stop' }
    $simulation.StopCount += 1
    $simulation.Events.Add('stop')
    $simulation.Phase = 'stopped'
  }
  function Start-Process {
    [CmdletBinding()]
    param([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory, [string]$WindowStyle)
    if ($FilePath -ne 'mock-pwsh.exe' -or $WindowStyle -ne 'Hidden' -or $simulation.Phase -ne 'stopped') { throw 'Unexpected simulated start' }
    if ($ArgumentList[-1] -ne (Join-Path $PSScriptRoot 'start-windows.ps1')) { throw 'Unexpected simulated launcher' }
    $simulation.StartCount += 1
    $simulation.Events.Add('start')
    $simulation.Phase = 'started'
  }
  function Get-Command {
    [CmdletBinding()]
    param([string]$Name)
    if ($Name -ne 'pwsh') { throw 'Unexpected simulated tool lookup' }
    return [pscustomobject]@{ Source = 'mock-pwsh.exe' }
  }
  function Start-Sleep {
    [CmdletBinding()]
    param([int]$Milliseconds)
  }

  $originalPort = [Environment]::GetEnvironmentVariable('PORT', 'Process')
  $originalNoOpen = [Environment]::GetEnvironmentVariable('NO_OPEN_BROWSER', 'Process')
  $errorMessage = $null
  $output = $null
  try {
    $env:PORT = '49173'
    $parameters = @{}
    if ($ForceDownloads) { $parameters.ForceActiveDownloads = $true }
    if ($ForceWb) { $parameters.ForceActiveWbPublishing = $true }
    $output = & $scriptPath @parameters 3>$null
  } catch {
    $errorMessage = $_.Exception.Message
  } finally {
    [Environment]::SetEnvironmentVariable('PORT', $originalPort, 'Process')
    [Environment]::SetEnvironmentVariable('NO_OPEN_BROWSER', $originalNoOpen, 'Process')
  }
  return [pscustomobject]@{ Simulation = $simulation; ErrorMessage = $errorMessage; Output = $output }
}

$scenarios = [Collections.Generic.List[string]]::new()
foreach ($state in $requiredStates) {
  $result = Invoke-MockedRestart -ActiveWbState $state
  Assert-RestartTest ($result.ErrorMessage -like '*存在活动 WB 自动上品任务*') "WB $state 必须阻止重启"
  Assert-RestartTest ($result.ErrorMessage -like "*$state=1*") "WB $state 必须出现在阻断提示中"
  Assert-RestartTest ($result.Simulation.StopCount -eq 0 -and $result.Simulation.StartCount -eq 0) "WB $state 不得触发进程操作"
  Assert-RestartTest (($result.Simulation.WbQueries -join ',') -eq ($requiredStates -join ',')) "WB $state 必须核验全部活动状态"
  $scenarios.Add("blocks-wb-$state")
}

$result = Invoke-MockedRestart -ApiFailure wb
Assert-RestartTest ($result.ErrorMessage -like '*无法核验活动 WB 自动上品任务，拒绝重启*') 'WB API 失败必须阻止重启'
Assert-RestartTest ($result.Simulation.StopCount -eq 0 -and $result.Simulation.StartCount -eq 0) 'WB API 失败不得触发进程操作'
$scenarios.Add('blocks-wb-api-failure')

foreach ($state in @('QUEUED', 'WAITING_RESOURCE', 'RUNNING')) {
  $result = Invoke-MockedRestart -ActiveDownloadState $state
  Assert-RestartTest ($result.ErrorMessage -like '*存在活动下载任务*') "原下载门禁 $state 必须保留"
  Assert-RestartTest ($result.Simulation.StopCount -eq 0 -and $result.Simulation.StartCount -eq 0) "下载 $state 不得触发进程操作"
  $scenarios.Add("blocks-download-$state")
}
$result = Invoke-MockedRestart -ApiFailure downloads
Assert-RestartTest ($result.ErrorMessage -like '*无法核验活动下载任务*') '下载 API 失败必须阻止重启'
Assert-RestartTest ($result.Simulation.StopCount -eq 0 -and $result.Simulation.StartCount -eq 0) '下载 API 失败不得触发进程操作'
$scenarios.Add('blocks-download-api-failure')

$result = Invoke-MockedRestart
Assert-RestartTest ([string]::IsNullOrEmpty($result.ErrorMessage)) "空闲模拟流程失败：$($result.ErrorMessage)"
Assert-RestartTest ($result.Simulation.StopCount -eq 1 -and $result.Simulation.StartCount -eq 1) '空闲模拟必须只停止并启动一次'
$expectedEvents = @('download:QUEUED', 'download:WAITING_RESOURCE', 'download:RUNNING') + @($requiredStates | ForEach-Object { "wb:$_" }) + @('stop', 'start', 'health')
Assert-RestartTest (($result.Simulation.Events -join ',') -eq ($expectedEvents -join ',')) '空闲模拟必须先完成全部门禁再停止、启动及回读'
$readback = ($result.Output -join "`n") | ConvertFrom-Json
Assert-RestartTest ($readback.pid -eq 2147483001 -and $readback.health.status -eq 'ok') '空闲模拟返回新 PID 与健康读回'
$scenarios.Add('idle-guard-stop-start-health-order')

$result = Invoke-MockedRestart -ActiveWbState RUNNING -ForceDownloads
Assert-RestartTest ($result.ErrorMessage -like '*存在活动 WB 自动上品任务*' -and $result.Simulation.StopCount -eq 0) 'ForceActiveDownloads 不得绕过 WB 门禁'
$scenarios.Add('download-force-does-not-bypass-wb')
$result = Invoke-MockedRestart -ActiveDownloadState RUNNING -ForceWb
Assert-RestartTest ($result.ErrorMessage -like '*存在活动下载任务*' -and $result.Simulation.StopCount -eq 0) 'ForceActiveWbPublishing 不得绕过下载门禁'
$scenarios.Add('wb-force-does-not-bypass-download')

[pscustomobject]@{
  ok = $true
  script = $scriptPath
  forceSwitch = 'ForceActiveWbPublishing'
  guardedStates = $requiredStates
  guardRunsBeforeStop = $true
  simulatedScenarios = $scenarios.Count
  scenarios = @($scenarios)
  realProcessOperations = 0
  realNetworkRequests = 0
} | ConvertTo-Json -Depth 4
