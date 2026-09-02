param(
  # Optional and isolated to a newly-created TEMP directory. Default testing is
  # read-only and never creates, renames, or removes a junction.
  [switch]$IncludeTemporaryNativeMutationTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptPath = Join-Path $PSScriptRoot 'retire-n8n-global-junction.ps1'
$source = Get-Content -Raw -LiteralPath $scriptPath
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
  throw "retire-n8n-global-junction.ps1 语法错误：$($parseErrors[0].Message)"
}

function Assert-Contains([string]$Needle, [string]$Message) {
  if ($source.IndexOf($Needle, [StringComparison]::Ordinal) -lt 0) { throw $Message }
}

function Assert-Before([string]$Earlier, [string]$Later, [string]$Message) {
  $earlierIndex = $source.IndexOf($Earlier, [StringComparison]::Ordinal)
  $laterIndex = $source.IndexOf($Later, [StringComparison]::Ordinal)
  if ($earlierIndex -lt 0 -or $laterIndex -lt 0 -or $earlierIndex -ge $laterIndex) { throw $Message }
}

$parameterNames = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
foreach ($forbiddenParameter in @('LegacyPath', 'TargetPath', 'DeletePath', 'QuarantinePath')) {
  if ($parameterNames -contains $forbiddenParameter) { throw "禁止把安全关键路径暴露为参数：$forbiddenParameter" }
}

foreach ($required in @(
  "`$script:LegacyPath = 'G:\01_n8n-global'",
  "`$script:TargetPath = 'G:\01_MerchRoute'",
  "`$script:MerchRouteAppDataPath = 'C:\Users\kylel\AppData\Roaming\n8n-media-review-center'",
  "`$script:BackupBase = 'D:\MerchRoute_Junction_Backups'",
  'FSCTL_GET_REPARSE_POINT',
  'IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003',
  'FILE_FLAG_OPEN_REPARSE_POINT',
  'FILE_ID_INFO',
  'GetSecurityInfo',
  'SetReparsePointSddl',
  'MoveFileExW',
  'MOVEFILE_WRITE_THROUGH',
  'EntryPoint = "RemoveDirectory2W"',
  'DIRECTORY_FLAGS_DISALLOW_PATH_REDIRECTS = 0x00000001',
  'RemoveJunctionNoRedirects',
  'Assert-QuarantinedJunction',
  'Find-LegacyRootReferences',
  'activeNodeLegacyReferenceCount = 0',
  'Get-ValidatedObservations',
  'AddHours(168)',
  'Invoke-DeployCompatibility',
  'Invoke-RecoverCutover',
  "phase = 'COMPATIBILITY_DEPLOYED'",
  "phase = 'QUARANTINE_RENAME_PENDING'",
  "phase = 'FINALIZING_LINK_REMOVED'",
  'Cancel-KnownE001StaleExecutions',
  "SET status='canceled'",
  'alreadyCanceled',
  'Assert-StateMatchesRelease',
  'Assert-LiveRuntimeMatchesRelease',
  'Assert-LiveAppDataPath',
  '[DateTimeOffset]::Now.AddSeconds(180)',
  ".tools\node-v22.23.1-win-x64",
  "`$nodeVersion -ne '22.23.1'",
  "`$npmVersion -ne '10.9.8'",
  '$owners = @(Get-ListeningPortOwners)',
  '$remaining = @(Get-ListeningPortOwners)',
  '$listening = @(Get-ListeningPortOwners)',
  'Get-RestoreRehearsalIndices',
  'Start-N8nRuntime',
  'Get-N8nRuntimeReadiness',
  'Test-N8nLauncherCommandLine',
  'Stop-VerifiedN8nLaunchersWithoutListeners',
  'Remove-ProcessEnvironmentVariable',
  'PGSSLMODE = [string]$connection.SslMode',
  'diff --name-only "$fromHead..$toHead" --',
  "Where-Object Port -in @(5678, 5679)",
  'recoveryPoint = $root',
  'deletedAt" IS NULL',
  "status IN ('new','running','waiting')",
  "status IN ('QUEUED','WAITING_RESOURCE','RUNNING')",
  "status='QUARANTINED'",
  "state IN ('QUARANTINING','QUARANTINED')",
  '/MIR', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/Z',
  'pg_dump.exe', 'pg_restore.exe',
  'export:workflow --backup',
  'export:workflow --all --published'
)) {
  Assert-Contains $required "缺少安全实现：$required"
}

foreach ($workflowId in @(
  'Wxng7hVbjMNhVOaO', 'HpCtxAZJdy9RgWk2', 's0lQIcv1ZCgEzGlB',
  'noHJuIiHfHryuA2e', 'aj5sD7nSxxpTuRMh', '6rGNfgghmkkeYhfG', 'G8MSbp9u0dudSgba'
)) {
  Assert-Contains $workflowId "E001-E007 门禁缺少工作流 ID：$workflowId"
}

# Junction deletion must never gain a recursive or legacy fallback.
$forbiddenPatterns = @(
  '(?im)\bRemove-Item\b',
  '(?im)\bDirectory\.Delete\s*\(',
  '(?im)\brd\s+/s\b',
  '(?im)\brmdir\b',
  '(?im)\bdel\s+/[sq]\b',
  '(?im)cmd(?:\.exe)?\s+/c'
)
foreach ($pattern in $forbiddenPatterns) {
  if ($source -match $pattern) { throw "发现禁止的删除/命令回退：$pattern" }
}

# Order checks are intentionally tied to operational function bodies.
$finalizeStart = $source.IndexOf('function Invoke-Finalize', [StringComparison]::Ordinal)
$finalizeText = $source.Substring($finalizeStart)
$observationIndex = $finalizeText.IndexOf('Get-ValidatedObservations', [StringComparison]::Ordinal)
$drainIndex = $finalizeText.IndexOf('Wait-OperationalDrain', [StringComparison]::Ordinal)
$identityIndex = $finalizeText.IndexOf('Assert-QuarantinedJunction', [StringComparison]::Ordinal)
$deleteIndex = $finalizeText.IndexOf('Remove-QuarantinedJunction', [StringComparison]::Ordinal)
if (@($observationIndex, $drainIndex, $identityIndex, $deleteIndex) | Where-Object { $_ -lt 0 }) {
  throw 'Finalize 缺少观察期、排空、身份或删除门禁'
}
if (-not ($observationIndex -lt $drainIndex -and $drainIndex -lt $identityIndex -and $identityIndex -lt $deleteIndex)) {
  throw 'Finalize 安全门禁顺序错误'
}

$cutoverStart = $source.IndexOf('function Invoke-Cutover', [StringComparison]::Ordinal)
$statusStart = $source.IndexOf('function Get-OperationalStatus', $cutoverStart, [StringComparison]::Ordinal)
$cutoverText = $source.Substring($cutoverStart, $statusStart - $cutoverStart)
$cutoverDrainIndex = $cutoverText.IndexOf('Wait-OperationalDrain -AllowKnownE001StaleExecutions', [StringComparison]::Ordinal)
$cutoverStopIndex = $cutoverText.IndexOf('Stop-VerifiedRuntime', [StringComparison]::Ordinal)
$cutoverFinalBackupIndex = $cutoverText.IndexOf('Invoke-BackupSet $root $finalLabel -Final', [StringComparison]::Ordinal)
$cutoverCancelIndex = $cutoverText.IndexOf('Cancel-KnownE001StaleExecutions', [StringComparison]::Ordinal)
$cutoverRenameIndex = $cutoverText.IndexOf('Move-LegacyJunctionToQuarantine', [StringComparison]::Ordinal)
if (@($cutoverDrainIndex, $cutoverStopIndex, $cutoverFinalBackupIndex, $cutoverCancelIndex, $cutoverRenameIndex) | Where-Object { $_ -lt 0 }) {
  throw 'Cutover 缺少排空、停止、最终备份、精确取消或隔离门禁'
}
if (-not ($cutoverDrainIndex -lt $cutoverStopIndex -and $cutoverStopIndex -lt $cutoverFinalBackupIndex -and
    $cutoverFinalBackupIndex -lt $cutoverCancelIndex -and $cutoverCancelIndex -lt $cutoverRenameIndex)) {
  throw 'Cutover 安全门禁顺序错误'
}

$prepareStart = $source.IndexOf('function Invoke-Prepare', [StringComparison]::Ordinal)
$prepareEnd = $source.IndexOf('function Move-LegacyJunctionToQuarantine', $prepareStart, [StringComparison]::Ordinal)
$prepareText = $source.Substring($prepareStart, $prepareEnd - $prepareStart)
$prepareHealthIndex = $prepareText.IndexOf('[void](Get-HealthGate)', [StringComparison]::Ordinal)
$prepareRecoveryIndex = $prepareText.IndexOf('New-RestrictedRecoveryPoint', [StringComparison]::Ordinal)
if ($prepareHealthIndex -lt 0 -or $prepareRecoveryIndex -lt 0 -or $prepareHealthIndex -ge $prepareRecoveryIndex) {
  throw 'Prepare 必须在创建恢复点前核验在线 AppData 路径'
}

$recoverStart = $source.IndexOf('function Invoke-RecoverCutover', [StringComparison]::Ordinal)
$deployStart = $source.IndexOf('function Invoke-DeployCompatibility', $recoverStart, [StringComparison]::Ordinal)
$recoverText = $source.Substring($recoverStart, $deployStart - $recoverStart)
$recoverDiffIndex = $recoverText.IndexOf('Assert-CutoverRecoveryReleaseDiff', [StringComparison]::Ordinal)
$recoverBackupIndex = $recoverText.IndexOf('Assert-CompletedFinalBackupForRecovery', [StringComparison]::Ordinal)
$recoverIdentityIndex = $recoverText.IndexOf('Assert-ExactLegacyJunction', [StringComparison]::Ordinal)
$recoverDrainIndex = $recoverText.IndexOf('Wait-OperationalDrain', [StringComparison]::Ordinal)
$recoverStartRuntimeIndex = $recoverText.IndexOf('Start-NewRuntime', [StringComparison]::Ordinal)
$recoverVerifyRuntimeIndex = $recoverText.IndexOf('Assert-LiveRuntimeMatchesRelease', [StringComparison]::Ordinal)
$recoverWriteIndex = $recoverText.IndexOf('Write-State $root $state', [StringComparison]::Ordinal)
if (@($recoverDiffIndex, $recoverBackupIndex, $recoverIdentityIndex, $recoverDrainIndex, $recoverStartRuntimeIndex,
      $recoverVerifyRuntimeIndex, $recoverWriteIndex) | Where-Object { $_ -lt 0 }) {
  throw 'RecoverCutover 缺少 release、最终备份、身份、排空、启动或状态门禁'
}
if (-not ($recoverDiffIndex -lt $recoverBackupIndex -and $recoverBackupIndex -lt $recoverIdentityIndex -and
    $recoverIdentityIndex -lt $recoverDrainIndex -and $recoverDrainIndex -lt $recoverStartRuntimeIndex -and
    $recoverStartRuntimeIndex -lt $recoverVerifyRuntimeIndex -and $recoverVerifyRuntimeIndex -lt $recoverWriteIndex)) {
  throw 'RecoverCutover 安全门禁顺序错误'
}
$recoverCatchIndex = $recoverText.IndexOf('  } catch {', [StringComparison]::Ordinal)
if ($recoverCatchIndex -lt 0) { throw 'RecoverCutover 缺少失败恢复路径' }
$recoverSuccessText = $recoverText.Substring(0, $recoverCatchIndex)
if ($recoverSuccessText.IndexOf('maintenanceRetained = $true', [StringComparison]::Ordinal) -lt 0 -or
    $recoverSuccessText.IndexOf('Exit-Maintenance $root', [StringComparison]::Ordinal) -ge 0) {
  throw 'RecoverCutover 成功后必须保持维护模式直至 Cutover 接管'
}

$startN8nStart = $source.IndexOf('function Start-N8nRuntime', [StringComparison]::Ordinal)
$startN8nEnd = $source.IndexOf('function Start-NewRuntime', $startN8nStart, [StringComparison]::Ordinal)
$startN8nText = $source.Substring($startN8nStart, $startN8nEnd - $startN8nStart)
if ($startN8nText -match '\$owners\.(?:Port|Pid)') {
  throw 'Start-N8nRuntime 仍直接访问可能为空数组的 Port/Pid 属性'
}

# Load only function definitions. This does not dispatch Status or any mutation action.
. $scriptPath -LibraryOnly

# Regression for PowerShell's empty pipeline unrolling. With no listeners this
# must be a no-op, not a StrictMode property-access failure. The function is
# replaced only inside this isolated test process, so no real PID can be stopped.
function Get-ListeningPortOwners { return @() }
[void](Stop-VerifiedRuntime -AllowAlreadyStopped)
$emptyReadiness = Get-N8nRuntimeReadiness -Owners @()
$onePortReadiness = Get-N8nRuntimeReadiness -Owners @([pscustomobject]@{ Port = 5678; Pid = 1 })
$readyReadiness = Get-N8nRuntimeReadiness -Owners @(
  [pscustomobject]@{ Port = 5678; Pid = 1 },
  [pscustomobject]@{ Port = 5679; Pid = 1 }
)
$splitPidReadiness = Get-N8nRuntimeReadiness -Owners @(
  [pscustomobject]@{ Port = 5678; Pid = 1 },
  [pscustomobject]@{ Port = 5679; Pid = 2 }
)
if ($emptyReadiness.Ready -or $onePortReadiness.Ready -or -not $readyReadiness.Ready -or $splitPidReadiness.Ready) {
  throw 'n8n 双端口同 PID readiness 回归'
}
foreach ($validLauncher in @(
  'C:\windows\system32\cmd.exe /c ""G:\01_MerchRoute\启动n8n.bat" "',
  '"C:\windows\system32\cmd.exe" /d /s /c "G:\01_MerchRoute\启动n8n.bat"'
)) {
  if (-not (Test-N8nLauncherCommandLine $validLauncher)) { throw "精确 n8n 启动器命令行被拒绝：$validLauncher" }
}
foreach ($invalidLauncher in @(
  'cmd.exe /c "G:\01_MerchRoute\启动n8n.bat-copy"',
  'cmd.exe /c echo G:\01_MerchRoute\启动n8n.bat-copy',
  'cmd.exe /c echo "G:\01_MerchRoute\启动n8n.bat"',
  'cmd.exe /c other.bat "G:\01_MerchRoute\启动n8n.bat"',
  'cmd.exe /k "G:\01_MerchRoute\启动n8n.bat"',
  'cmd.exe /c "G:\01_MerchRoute\启动n8n.bat\child"'
)) {
  if (Test-N8nLauncherCommandLine $invalidLauncher) { throw "近似或非执行 n8n 命令行被接受：$invalidLauncher" }
}

# PostgreSQL treats an existing-but-empty PGSSLMODE as invalid. Verify that the
# helper restores both existence and value exactly and leaves no test-process
# environment changes behind.
$pgKeys = @('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE')
$originalPgState = @{}
foreach ($key in $pgKeys) {
  $originalPgState[$key] = [pscustomobject]@{
    Exists = Test-Path -LiteralPath "Env:$key"
    Value = [Environment]::GetEnvironmentVariable($key, 'Process')
  }
}
$testConnection = [pscustomobject]@{
  Host = '127.0.0.1'
  Port = '5432'
  User = 'test-user'
  Password = 'test-password'
  Database = 'test-database'
  SslMode = 'disable'
}
try {
  foreach ($key in $pgKeys) { Remove-ProcessEnvironmentVariable $key }
  $seen = Invoke-WithPgEnvironment $testConnection {
    [pscustomobject]@{
      Host = $env:PGHOST
      Port = $env:PGPORT
      User = $env:PGUSER
      Password = $env:PGPASSWORD
      Database = $env:PGDATABASE
      SslMode = $env:PGSSLMODE
    }
  }
  if ($seen.Host -ne $testConnection.Host -or $seen.Port -ne $testConnection.Port -or
      $seen.User -ne $testConnection.User -or $seen.Password -ne $testConnection.Password -or
      $seen.Database -ne $testConnection.Database -or $seen.SslMode -ne $testConnection.SslMode) {
    throw 'Invoke-WithPgEnvironment 未向操作传入完整 PostgreSQL 环境'
  }
  if (@($pgKeys | Where-Object { Test-Path -LiteralPath "Env:$_" }).Count -ne 0) {
    throw 'Invoke-WithPgEnvironment 把原本不存在的 PG 环境恢复成了空值'
  }

  [Environment]::SetEnvironmentVariable('PGHOST', 'original-host', 'Process')
  [Environment]::SetEnvironmentVariable('PGSSLMODE', '', 'Process')
  $operationFailureObserved = $false
  try {
    [void](Invoke-WithPgEnvironment $testConnection { throw 'intentional-pg-environment-test-failure' })
  } catch {
    if ($_.Exception.Message -ne 'intentional-pg-environment-test-failure') { throw }
    $operationFailureObserved = $true
  }
  if (-not $operationFailureObserved) { throw 'Invoke-WithPgEnvironment 异常路径测试未触发' }
  if ($env:PGHOST -ne 'original-host' -or -not (Test-Path -LiteralPath 'Env:PGSSLMODE') -or $env:PGSSLMODE -ne '') {
    throw 'Invoke-WithPgEnvironment 异常后未原样恢复既有非空值或真正空值'
  }
  if (@('PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE') | Where-Object { Test-Path -LiteralPath "Env:$_" }) {
    throw 'Invoke-WithPgEnvironment 污染了部分不存在的 PG 环境变量'
  }
} finally {
  foreach ($key in $pgKeys) {
    if ($originalPgState[$key].Exists) {
      [Environment]::SetEnvironmentVariable($key, [string]$originalPgState[$key].Value, 'Process')
    } else {
      Remove-ProcessEnvironmentVariable $key
    }
  }
}
if ((@(Get-RestoreRehearsalIndices 1) -join ',') -ne '0' -or
    (@(Get-RestoreRehearsalIndices 2) -join ',') -ne '0,1' -or
    (@(Get-RestoreRehearsalIndices 5) -join ',') -ne '0,2,4') {
  throw '恢复抽查索引计算回归'
}

if ((Get-NormalizedLiteralPath 'G:\01_n8n-global\') -ne 'G:\01_n8n-global') {
  throw '固定路径规范化失败'
}
if ((ConvertFrom-ReparseTarget '\??\G:\01_MerchRoute') -ne 'G:\01_MerchRoute') {
  throw 'Mount-point substitute name 规范化失败'
}
try {
  [void](Assert-QuarantinePath 'G:\01_n8n-global.__quarantine__20260902-180000')
} catch {
  throw "合法隔离路径被拒绝：$($_.Exception.Message)"
}
foreach ($invalid in @(
  'G:\01_n8n-global',
  'G:\01_n8n-global.__quarantine__bad',
  'D:\01_n8n-global.__quarantine__20260902-180000',
  'G:\01_n8n-global.__quarantine__20260902-180000\child'
)) {
  $rejected = $false
  try { [void](Assert-QuarantinePath $invalid) } catch { $rejected = $true }
  if (-not $rejected) { throw "不安全隔离路径未被拒绝：$invalid" }
}

$legacyHits = @(Find-LegacyRootReferences ([pscustomobject]@{
  exact = 'G:\01_n8n-global'
  child = 'const p = "g:/01_N8N-GLOBAL/media/file.jpg";'
  approximate = 'G:\01_n8n-global-copy\file.jpg'
}))
if ($legacyHits.Count -ne 2 -or $legacyHits -contains '$.approximate') {
  throw '活动工作流节点旧根边界扫描失败'
}

$ordinaryIdentity = [MerchRoute.JunctionRetirement.NativeFs]::GetFileIdentity($env:TEMP, $true)
if (-not $ordinaryIdentity.FileId -or $ordinaryIdentity.IsReparsePoint) {
  throw '原生 FileIdInfo 普通目录只读检查失败'
}

if ($IncludeTemporaryNativeMutationTest) {
  $temporaryRoot = Join-Path $env:TEMP "merchroute-junction-retirement-test-$([Guid]::NewGuid().ToString('N'))"
  $temporaryTarget = Join-Path $temporaryRoot 'target'
  $temporaryLink = Join-Path $temporaryRoot 'legacy-link'
  $temporaryQuarantine = Join-Path $temporaryRoot 'legacy-link.quarantine'
  [IO.Directory]::CreateDirectory($temporaryTarget) | Out-Null
  [IO.File]::WriteAllText((Join-Path $temporaryTarget 'proof.txt'), 'target-must-survive')
  try {
    $aclProbe = Join-Path $temporaryRoot 'runtime-file-acl-probe.tmp'
    [IO.File]::WriteAllText($aclProbe, 'restricted')
    Set-RestrictedRuntimeFileAcl $aclProbe
    Assert-RestrictedAcl $aclProbe
    [IO.File]::Delete($aclProbe)
    New-Item -ItemType Junction -Path $temporaryLink -Target $temporaryTarget | Out-Null
    $beforeTarget = [MerchRoute.JunctionRetirement.NativeFs]::GetFileIdentity($temporaryTarget, $true)
    $link = [MerchRoute.JunctionRetirement.NativeFs]::GetMountPointIdentity($temporaryLink)
    if ($link.ReparseTag -ne [uint32](0xA0000003L)) { throw '临时对象不是 Junction' }
    [MerchRoute.JunctionRetirement.NativeFs]::SetReparsePointSddl($temporaryLink, $link.Sddl)
    $linkAfterAclRoundTrip = [MerchRoute.JunctionRetirement.NativeFs]::GetMountPointIdentity($temporaryLink)
    if ($linkAfterAclRoundTrip.Sddl -ne $link.Sddl) { throw '临时 Junction SDDL 原生回写读回不一致' }
    [MerchRoute.JunctionRetirement.NativeFs]::MoveJunctionWriteThrough($temporaryLink, $temporaryQuarantine)
    if ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($temporaryLink)) { throw '临时 Junction 改名失败' }
    [MerchRoute.JunctionRetirement.NativeFs]::RemoveJunctionNoRedirects($temporaryQuarantine)
    if ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($temporaryQuarantine)) { throw '临时 Junction 删除失败' }
    $afterTarget = [MerchRoute.JunctionRetirement.NativeFs]::GetFileIdentity($temporaryTarget, $true)
    if (-not (Test-IdentityEqual $beforeTarget $afterTarget) -or -not [IO.File]::Exists((Join-Path $temporaryTarget 'proof.txt'))) {
      throw '临时 Junction 删除影响了真实目标'
    }
  } finally {
    # Cleanup is restricted to known, empty objects below the GUID-named TEMP
    # root. It uses the same no-redirect native directory primitive and has no
    # recursive fallback.
    if ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($temporaryQuarantine)) {
      [MerchRoute.JunctionRetirement.NativeFs]::RemoveJunctionNoRedirects($temporaryQuarantine)
    }
    if ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($temporaryLink)) {
      [MerchRoute.JunctionRetirement.NativeFs]::RemoveJunctionNoRedirects($temporaryLink)
    }
    $proof = Join-Path $temporaryTarget 'proof.txt'
    $aclProbe = Join-Path $temporaryRoot 'runtime-file-acl-probe.tmp'
    if ([IO.File]::Exists($aclProbe)) { [IO.File]::Delete($aclProbe) }
    if ([IO.File]::Exists($proof)) { [IO.File]::Delete($proof) }
    if ([IO.Directory]::Exists($temporaryTarget)) {
      [MerchRoute.JunctionRetirement.NativeFs]::RemoveJunctionNoRedirects($temporaryTarget)
    }
    if ([IO.Directory]::Exists($temporaryRoot)) {
      [MerchRoute.JunctionRetirement.NativeFs]::RemoveJunctionNoRedirects($temporaryRoot)
    }
  }
}

[pscustomobject]@{
  ok = $true
  script = $scriptPath
  syntaxValid = $true
  fixedLegacyPath = 'G:\01_n8n-global'
  fixedTargetPath = 'G:\01_MerchRoute'
  nativeFileIdReadVerified = $true
  operationalActionsInvoked = $false
  realPathsMutated = $false
  temporaryNativeMutationTest = [bool]$IncludeTemporaryNativeMutationTest
  deletionPrimitive = 'RemoveDirectory2W(DIRECTORY_FLAGS_DISALLOW_PATH_REDIRECTS)'
} | ConvertTo-Json -Depth 5
