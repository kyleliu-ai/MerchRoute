[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Inspect','Stop','Bind','RestoreShortcuts','StartLegacy')][string]$Action,
      [Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference='Stop'
$env:PSModulePath=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules')
$utf8NoBom=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$utf8NoBom
$OutputEncoding=$utf8NoBom
$data=Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Action -eq 'Inspect' -or $Action -eq 'Stop') {
  $port=[int]$data.runtimeEndpoint.port
  if($data.runtimeEndpoint.host -ne '127.0.0.1' -or $port -lt 1024 -or $port -gt 49151){throw 'Invalid runtime endpoint.'}
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($listeners.Count -eq 0 -and $Action -eq 'Inspect') { '{"stopped":true}'; exit 0 }
  if ($listeners.Count -ne 1) { throw 'Ambiguous production process.' }
  $proc=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$listeners[0])
  $entry=$data.entry.Replace('/','\')
  if ($proc.CommandLine.Replace('/','\').IndexOf($entry,[StringComparison]::OrdinalIgnoreCase) -lt 0 -or $proc.ExecutablePath.Replace('/','\') -ine $data.nodePath.Replace('/','\')) { throw 'Production process path mismatch.' }
  if ($Action -eq 'Stop') {
    $createdAt=$proc.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)
    if ([int]$data.pid -ne [int]$proc.ProcessId -or [string]$data.createdAt -ne $createdAt) { throw 'Production PID identity changed.' }
    Stop-Process -Id $proc.ProcessId -ErrorAction Stop
    Wait-Process -Id $proc.ProcessId -Timeout 20 -ErrorAction SilentlyContinue
  } else { @{pid=[int]$proc.ProcessId;createdAt=$proc.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)}|ConvertTo-Json -Compress }
} elseif ($Action -eq 'Bind') {
  if ((Get-FileHash -LiteralPath $data.launcher -Algorithm SHA256).Hash.ToLowerInvariant() -ne $data.launcherSha256) { throw 'Fixed launcher changed.' }
  $shell=New-Object -ComObject WScript.Shell
  foreach ($item in $data.shortcuts) {
    $file=if($item -is [string]){$item}else{$item.path}
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Unknown shortcut target.' }
    $shortcut=$shell.CreateShortcut($file)
    $shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $openBrowser=if($item -is [string]){$file.IndexOf('\Startup\',[StringComparison]::OrdinalIgnoreCase) -lt 0}else{[bool]$item.openBrowser}
    $shortcut.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$data.launcher+'"' + $(if($openBrowser){' -OpenBrowser'}else{''})
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
