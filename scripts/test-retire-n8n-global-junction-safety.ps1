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
  "phase = 'COMPATIBILITY_DEPLOYED'",
  "phase = 'QUARANTINE_RENAME_PENDING'",
  "phase = 'FINALIZING_LINK_REMOVED'",
  'Cancel-KnownE001StaleExecutions',
  "SET status='canceled'",
  'alreadyCanceled',
  'Assert-StateMatchesRelease',
  'Assert-LiveRuntimeMatchesRelease',
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

# Load only function definitions. This does not dispatch Status or any mutation action.
. $scriptPath -LibraryOnly

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
