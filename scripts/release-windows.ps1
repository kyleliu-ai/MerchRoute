[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Inspect','Stop','Bind','RestoreShortcuts','StartLegacy')][string]$Action,
      [Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference='Stop'
$env:PSModulePath=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules')
$data=Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Action -eq 'Inspect' -or $Action -eq 'Stop') {
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 4173 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($listeners.Count -eq 0 -and $Action -eq 'Inspect') { '{"stopped":true}'; exit 0 }
  if ($listeners.Count -ne 1) { throw 'Ambiguous production process.' }
  $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0])
  $entry=$data.entry.Replace('/','\')
  if ($proc.CommandLine.Replace('/','\').IndexOf($entry,[StringComparison]::OrdinalIgnoreCase) -lt 0 -or $proc.ExecutablePath.Replace('/','\') -ine $data.nodePath.Replace('/','\')) { throw 'Production process path mismatch.' }
  if ($Action -eq 'Stop') {
    if ([int]$data.pid -ne [int]$proc.ProcessId -or $data.createdAt -ne $proc.CreationDate.ToUniversalTime().ToString('o')) { throw 'Production PID identity changed.' }
    Stop-Process -Id $proc.ProcessId -ErrorAction Stop
    Wait-Process -Id $proc.ProcessId -Timeout 20 -ErrorAction SilentlyContinue
  } else { @{pid=[int]$proc.ProcessId;createdAt=$proc.CreationDate.ToUniversalTime().ToString('o');entry=$data.entry;nodePath=$data.nodePath}|ConvertTo-Json -Compress }
} elseif ($Action -eq 'Bind') {
  if ((Get-FileHash -LiteralPath $data.launcher -Algorithm SHA256).Hash.ToLowerInvariant() -ne $data.launcherSha256) { throw 'Fixed launcher changed.' }
  $shell=New-Object -ComObject WScript.Shell
  foreach ($file in $data.shortcuts) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Unknown shortcut target.' }
    $shortcut=$shell.CreateShortcut($file)
    $shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$data.launcher+'"'
    $shortcut.WorkingDirectory=Split-Path -Parent $data.launcher
    $shortcut.WindowStyle=7
    $shortcut.Save()
  }
} elseif ($Action -eq 'RestoreShortcuts') {
  foreach ($item in $data.shortcuts) {
    if ((Get-FileHash -LiteralPath $item.backup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) { throw 'Shortcut backup changed.' }
    Copy-Item -LiteralPath $item.backup -Destination $item.path
  }
} elseif ($Action -eq 'StartLegacy') {
  if ((Get-FileHash -LiteralPath $data.launcher -Algorithm SHA256).Hash.ToLowerInvariant() -ne $data.launcherSha256) { throw 'Legacy launcher changed.' }
  Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$data.launcher+'"')) -WindowStyle Hidden
}
