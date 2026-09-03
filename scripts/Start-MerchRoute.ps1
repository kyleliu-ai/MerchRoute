[CmdletBinding()]
param([string]$ReleasePointer = (Join-Path $env:LOCALAPPDATA 'MerchRoute\current-release.json'), [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
function Get-ReleaseHash([string]$File) {
  $stream=[IO.File]::OpenRead($File)
  $algorithm=[Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
if (-not [IO.Path]::IsPathRooted($ReleasePointer)) { throw 'An absolute release pointer is required.' }
$binding = Get-Content -LiteralPath $ReleasePointer -Raw -Encoding UTF8 | ConvertFrom-Json
$entry = Join-Path $binding.root 'scripts\release-runtime.mjs'
if ((Get-ReleaseHash $binding.nodePath) -ne $binding.nodeSha256) { throw 'Node hash mismatch.' }
if ((Get-ReleaseHash $entry) -ne $binding.launcherSha256) { throw 'Release launcher hash mismatch.' }
if ($CheckOnly) { Write-Output 'Launcher binding verified'; exit 0 }
& $binding.nodePath $entry start $ReleasePointer
if ($LASTEXITCODE -ne 0) { throw 'MerchRoute refused to start. No fallback source directory was used.' }
