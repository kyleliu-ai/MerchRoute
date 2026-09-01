[CmdletBinding()]
param(
  [switch]$FromClipboard
)

$ErrorActionPreference = 'Stop'
$VariableName = 'MERCHROUTE_GITHUB_TOKEN'
$RepositoryApi = 'https://api.github.com/repos/kyleliu-ai/MerchRoute/git/trees/main?recursive=0'
$RuntimeEnvFile = if ($env:MERCHROUTE_ENV_FILE) {
  $env:MERCHROUTE_ENV_FILE
} else {
  [Environment]::GetEnvironmentVariable('MERCHROUTE_ENV_FILE', 'User')
}

if ([string]::IsNullOrWhiteSpace($RuntimeEnvFile) -or -not [IO.Path]::IsPathRooted($RuntimeEnvFile)) {
  throw 'MERCHROUTE_ENV_FILE must be configured as an absolute path.'
}
$RuntimeEnvFile = [IO.Path]::GetFullPath($RuntimeEnvFile)
if (-not (Test-Path -LiteralPath $RuntimeEnvFile -PathType Leaf)) {
  throw 'The external MerchRoute runtime environment file does not exist.'
}

$TokenPointer = [IntPtr]::Zero
$Token = $null
if ($FromClipboard) {
  $Token = ([string](Get-Clipboard -Raw)).Trim()
} else {
  Write-Host 'Paste a fine-grained GitHub token limited to MerchRoute with Contents: read.' -ForegroundColor Cyan
  $SecureToken = Read-Host 'Token (input is hidden)' -AsSecureString
  $TokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureToken)
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($TokenPointer)
}
try {
  if ($Token -notmatch '^github_pat_[A-Za-z0-9_]+$') {
    throw 'Only a fine-grained GitHub token beginning with github_pat_ is accepted.'
  }

  $Headers = @{
    Accept = 'application/vnd.github+json'
    Authorization = "Bearer $Token"
    'User-Agent' = 'MerchRoute-token-configurator'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  try {
    $Response = Invoke-WebRequest -Uri $RepositoryApi -Headers $Headers -Method Get -TimeoutSec 15 -UseBasicParsing
  } catch {
    throw 'The GitHub token is invalid, expired, or cannot read MerchRoute repository contents.'
  }
  if ($Response.StatusCode -ne 200) {
    throw 'The GitHub token did not pass the MerchRoute repository read-access check.'
  }

  $Lines = [Collections.Generic.List[string]]::new()
  $Found = $false
  foreach ($Line in [IO.File]::ReadAllLines($RuntimeEnvFile)) {
    if ($Line -match "^\s*$VariableName\s*=") {
      if (-not $Found) { $Lines.Add("$VariableName=$Token") }
      $Found = $true
    } else {
      $Lines.Add($Line)
    }
  }
  if (-not $Found) {
    if ($Lines.Count -gt 0 -and $Lines[$Lines.Count - 1] -ne '') { $Lines.Add('') }
    $Lines.Add("$VariableName=$Token")
  }

  $Directory = [IO.Path]::GetDirectoryName($RuntimeEnvFile)
  $Leaf = [IO.Path]::GetFileName($RuntimeEnvFile)
  $BackupFile = Join-Path $Directory "$Leaf.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  $Encoding = [Text.UTF8Encoding]::new($false)
  Copy-Item -LiteralPath $RuntimeEnvFile -Destination $BackupFile -ErrorAction Stop
  try {
    [IO.File]::WriteAllLines($RuntimeEnvFile, $Lines, $Encoding)
  } catch {
    Copy-Item -LiteralPath $BackupFile -Destination $RuntimeEnvFile -Force
    throw
  }

  Write-Host 'The GitHub read-only token was verified and saved outside the repository; the previous file was backed up.' -ForegroundColor Green
  Write-Host 'Restart MerchRoute to apply the token.' -ForegroundColor Yellow
} finally {
  $Token = $null
  if ($TokenPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($TokenPointer)
  }
  if ($FromClipboard) {
    Set-Clipboard -Value ' '
  }
}
