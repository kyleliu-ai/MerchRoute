#requires -Version 7.4
<#
.SYNOPSIS
  Safely retires the single, fixed MerchRoute legacy junction.

.DESCRIPTION
  This runbook is deliberately bound to these exact paths:
    G:\01_n8n-global -> G:\01_MerchRoute

  It implements a gated state machine:
    Prepare -> DeployCompatibility -> Cutover -> Observe -> Finalize
                 \-> Rollback            \-> Rollback

  Finalize is the only action that removes the quarantined junction. Its only
  deletion primitive is Windows 11 24H2 RemoveDirectory2W with
  DIRECTORY_FLAGS_DISALLOW_PATH_REDIRECTS. There is no recursive or legacy
  deletion fallback.

  Prepare performs a live pre-copy. Cutover enters application maintenance,
  drains all known queues, stops only verified PIDs, makes the final mirror and
  logical dumps, changes the runtime compatibility settings, renames the
  junction on the same volume, and starts from this worktree. Finalize is
  refused until at least 168 hours and all required operational coverage are
  recorded.

  Run test-retire-n8n-global-junction-safety.ps1 before any operational action.
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [ValidateSet('Prepare', 'DeployCompatibility', 'RecoverCutover', 'Cutover', 'Status', 'Rollback', 'Observe', 'Finalize')]
  [string]$Action = 'Status',

  [string]$RecoveryPoint,

  [ValidateSet(
    'E001', 'E002', 'E003', 'E004', 'E005', 'E006', 'E007',
    'DOWNLOAD', 'HISTORICAL_PREVIEW', 'FAILED_RETRY',
    'OZON_DRAFT', 'OZON_READY', 'OZON_NEEDS_ATTENTION',
    'WB_HISTORY', 'OZON_HISTORY', 'MANIFEST', 'TEMPLATE', 'WORK_DIRECTORY'
  )]
  [string[]]$CoveredCapability = @(),

  # Used only by the safety test to load functions without dispatching an action.
  [switch]$LibraryOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:LegacyPath = 'G:\01_n8n-global'
$script:TargetPath = 'G:\01_MerchRoute'
$script:N8nUserDataPath = 'D:\globle_n8n-data'
$script:MerchRouteAppDataPath = 'C:\Users\kylel\AppData\Roaming\n8n-media-review-center'
$script:MerchRouteEnvPath = 'C:\Users\kylel\AppData\Local\MerchRoute\secrets\merchroute.env'
$script:MerchRoutePort = 43173
if ($env:MERCHROUTE_PORT) { $script:MerchRoutePort = [int]$env:MERCHROUTE_PORT }
elseif (Test-Path -LiteralPath $script:MerchRouteEnvPath) {
  $portLine = Get-Content -LiteralPath $script:MerchRouteEnvPath | Where-Object { $_ -match '^MERCHROUTE_PORT=' } | Select-Object -First 1
  if (-not $portLine) { $portLine = Get-Content -LiteralPath $script:MerchRouteEnvPath | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1 }
  if ($portLine) { $script:MerchRoutePort = [int]($portLine -replace '^[^=]+=', '') }
}
if ($script:MerchRoutePort -lt 1024 -or $script:MerchRoutePort -gt 49151 -or @(4183,4184,5173,5432,5678,8000) -contains $script:MerchRoutePort) { throw 'MerchRoute runtime port is invalid or reserved' }
$script:N8nEnvPath = 'D:\globle_n8n-data\.n8n\.env'
$script:N8nLauncherPath = 'G:\01_MerchRoute\启动n8n.bat'
$script:StartupDirectory = 'C:\Users\kylel\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
$script:MerchRouteShortcutPath = Join-Path $script:StartupDirectory 'start-windows.cmd - 快捷方式.lnk'
$script:N8nShortcutPath = Join-Path $script:StartupDirectory '启动n8n.bat - 快捷方式.lnk'
$script:BackupBase = 'D:\MerchRoute_Junction_Backups'
$script:MaintenanceMarkerPath = Join-Path $script:MerchRouteAppDataPath '.junction-retirement-maintenance-v1.json'
$script:CompatibilityRequiredMarkerPath = Join-Path $script:MerchRouteAppDataPath '.legacy-root-retirement-required-v1.json'
$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:StateFileName = 'state.json'
$script:ObservationsFileName = 'observations.jsonl'
$script:MaintenanceToken = [Guid]::NewGuid().ToString('N')
$script:RequiredCoverage = @(
  'E001', 'E002', 'E003', 'E004', 'E005', 'E006', 'E007',
  'DOWNLOAD', 'HISTORICAL_PREVIEW', 'FAILED_RETRY',
  'OZON_DRAFT', 'OZON_READY', 'OZON_NEEDS_ATTENTION',
  'WB_HISTORY', 'OZON_HISTORY', 'MANIFEST', 'TEMPLATE', 'WORK_DIRECTORY'
)
$script:EWorkflowIds = @(
  'Wxng7hVbjMNhVOaO', # E001
  'HpCtxAZJdy9RgWk2', # E002
  's0lQIcv1ZCgEzGlB', # E003
  'noHJuIiHfHryuA2e', # E004
  'aj5sD7nSxxpTuRMh', # E005
  '6rGNfgghmkkeYhfG', # E006
  'G8MSbp9u0dudSgba'  # E007
)

if (-not ('MerchRoute.JunctionRetirement.NativeFs' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace MerchRoute.JunctionRetirement
{
    public class FileIdentity
    {
        public ulong VolumeSerialNumber { get; set; }
        public string FileId { get; set; } = "";
        public uint Attributes { get; set; }
        public bool IsReparsePoint { get; set; }
        public override string ToString() => $"{VolumeSerialNumber:x16}:{FileId}";
    }

    public sealed class ReparseIdentity : FileIdentity
    {
        public uint ReparseTag { get; set; }
        public string SubstituteName { get; set; } = "";
        public string PrintName { get; set; } = "";
        public string Sddl { get; set; } = "";
    }

    public static class NativeFs
    {
        private const uint FILE_READ_ATTRIBUTES = 0x00000080;
        private const uint READ_CONTROL = 0x00020000;
        private const uint WRITE_DAC = 0x00040000;
        private const uint WRITE_OWNER = 0x00080000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FSCTL_GET_REPARSE_POINT = 0x000900A8;
        private const uint IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003;
        private const uint MOVEFILE_WRITE_THROUGH = 0x00000008;
        public const uint DIRECTORY_FLAGS_DISALLOW_PATH_REDIRECTS = 0x00000001;
        private const int FileIdInfo = 18;
        private const int SE_FILE_OBJECT = 1;
        private const uint OWNER_SECURITY_INFORMATION = 0x00000001;
        private const uint GROUP_SECURITY_INFORMATION = 0x00000002;
        private const uint DACL_SECURITY_INFORMATION = 0x00000004;
        private const uint SDDL_REVISION_1 = 1;

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_ID_128
        {
            public ulong Low;
            public ulong High;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FILE_ID_INFO
        {
            public ulong VolumeSerialNumber;
            public FILE_ID_128 FileId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
            uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleEx(
            SafeFileHandle file, int informationClass, out FILE_ID_INFO information, uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeviceIoControl(
            SafeFileHandle device, uint controlCode, IntPtr inBuffer, uint inBufferSize,
            [Out] byte[] outBuffer, uint outBufferSize, out uint bytesReturned, IntPtr overlapped);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern uint GetSecurityInfo(
            IntPtr handle, int objectType, uint securityInfo,
            out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl,
            out IntPtr securityDescriptor);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
            IntPtr securityDescriptor, uint requestedRevision, uint securityInformation,
            out IntPtr stringSecurityDescriptor, out uint stringLength);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string stringSecurityDescriptor, uint stringSDRevision,
            out IntPtr securityDescriptor, out uint securityDescriptorSize);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorOwner(
            IntPtr securityDescriptor, out IntPtr owner, out bool ownerDefaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorGroup(
            IntPtr securityDescriptor, out IntPtr group, out bool groupDefaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetSecurityDescriptorDacl(
            IntPtr securityDescriptor, out bool daclPresent, out IntPtr dacl, out bool daclDefaulted);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern uint SetSecurityInfo(
            IntPtr handle, int objectType, uint securityInfo,
            IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool MoveFileExW(string existingName, string newName, uint flags);

        [DllImport("kernel32.dll", EntryPoint = "RemoveDirectory2W", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool RemoveDirectory2W(string path, uint directoryFlags);

        private static string Extended(string path)
        {
            string full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (full.StartsWith(@"\\?\", StringComparison.Ordinal)) return full;
            if (full.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + full.Substring(2);
            return @"\\?\" + full;
        }

        private static SafeFileHandle Open(string path, bool openReparsePoint, uint desiredAccess)
        {
            uint flags = FILE_FLAG_BACKUP_SEMANTICS;
            if (openReparsePoint) flags |= FILE_FLAG_OPEN_REPARSE_POINT;
            SafeFileHandle handle = CreateFileW(
                Extended(path), desiredAccess, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error, $"CreateFileW failed for {path}");
            }
            return handle;
        }

        private static FileIdentity IdentityFromHandle(SafeFileHandle handle, uint attributes)
        {
            if (!GetFileInformationByHandleEx(handle, FileIdInfo, out FILE_ID_INFO info,
                (uint)Marshal.SizeOf<FILE_ID_INFO>()))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetFileInformationByHandleEx(FileIdInfo) failed");

            byte[] low = BitConverter.GetBytes(info.FileId.Low);
            byte[] high = BitConverter.GetBytes(info.FileId.High);
            byte[] identifier = new byte[16];
            Buffer.BlockCopy(low, 0, identifier, 0, 8);
            Buffer.BlockCopy(high, 0, identifier, 8, 8);
            return new FileIdentity {
                VolumeSerialNumber = info.VolumeSerialNumber,
                FileId = BitConverter.ToString(identifier).Replace("-", "").ToLowerInvariant(),
                Attributes = attributes,
                IsReparsePoint = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
            };
        }

        private static string SddlFromHandle(SafeFileHandle handle)
        {
            uint requested = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
            uint error = GetSecurityInfo(handle.DangerousGetHandle(), SE_FILE_OBJECT, requested,
                out _, out _, out _, out _, out IntPtr descriptor);
            if (error != 0) throw new Win32Exception((int)error, "GetSecurityInfo failed");
            IntPtr text = IntPtr.Zero;
            try
            {
                if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor, SDDL_REVISION_1, requested, out text, out _))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertSecurityDescriptorToStringSecurityDescriptorW failed");
                return Marshal.PtrToStringUni(text) ?? "";
            }
            finally
            {
                if (text != IntPtr.Zero) LocalFree(text);
                if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            }
        }

        public static FileIdentity GetFileIdentity(string path, bool openReparsePoint)
        {
            FileAttributes attrs = File.GetAttributes(path);
            using SafeFileHandle handle = Open(path, openReparsePoint, FILE_READ_ATTRIBUTES);
            return IdentityFromHandle(handle, (uint)attrs);
        }

        public static ReparseIdentity GetMountPointIdentity(string path)
        {
            FileAttributes attrs = File.GetAttributes(path);
            if ((((uint)attrs) & FILE_ATTRIBUTE_REPARSE_POINT) == 0)
                throw new InvalidOperationException($"Not a reparse point: {path}");

            using SafeFileHandle handle = Open(path, true, FILE_READ_ATTRIBUTES | READ_CONTROL);
            byte[] buffer = new byte[16 * 1024];
            if (!DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, IntPtr.Zero, 0,
                buffer, (uint)buffer.Length, out uint returned, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), $"FSCTL_GET_REPARSE_POINT failed for {path}");
            if (returned < 16) throw new InvalidDataException("Truncated reparse buffer");

            uint tag = BitConverter.ToUInt32(buffer, 0);
            if (tag != IO_REPARSE_TAG_MOUNT_POINT)
                throw new InvalidOperationException($"Unexpected reparse tag 0x{tag:x8} for {path}");
            ushort substituteOffset = BitConverter.ToUInt16(buffer, 8);
            ushort substituteLength = BitConverter.ToUInt16(buffer, 10);
            ushort printOffset = BitConverter.ToUInt16(buffer, 12);
            ushort printLength = BitConverter.ToUInt16(buffer, 14);
            const int pathBufferOffset = 16;
            if (pathBufferOffset + substituteOffset + substituteLength > returned ||
                pathBufferOffset + printOffset + printLength > returned)
                throw new InvalidDataException("Invalid mount-point path offsets");

            FileIdentity identity = IdentityFromHandle(handle, (uint)attrs);
            return new ReparseIdentity {
                VolumeSerialNumber = identity.VolumeSerialNumber,
                FileId = identity.FileId,
                Attributes = identity.Attributes,
                IsReparsePoint = true,
                ReparseTag = tag,
                SubstituteName = Encoding.Unicode.GetString(buffer, pathBufferOffset + substituteOffset, substituteLength),
                PrintName = Encoding.Unicode.GetString(buffer, pathBufferOffset + printOffset, printLength),
                Sddl = SddlFromHandle(handle)
            };
        }

        public static bool ExistsNoFollow(string path)
        {
            try
            {
                using SafeFileHandle handle = Open(path, true, 0);
                return true;
            }
            catch (Win32Exception ex) when (ex.NativeErrorCode == 2 || ex.NativeErrorCode == 3)
            {
                return false;
            }
        }

        public static void MoveJunctionWriteThrough(string source, string destination)
        {
            if (!MoveFileExW(Extended(source), Extended(destination), MOVEFILE_WRITE_THROUGH))
                throw new Win32Exception(Marshal.GetLastWin32Error(), $"MoveFileExW failed: {source} -> {destination}");
        }

        public static void SetReparsePointSddl(string path, string sddl)
        {
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, SDDL_REVISION_1, out IntPtr descriptor, out _))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Invalid SDDL");
            try
            {
                if (!GetSecurityDescriptorOwner(descriptor, out IntPtr owner, out _))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetSecurityDescriptorOwner failed");
                if (!GetSecurityDescriptorGroup(descriptor, out IntPtr group, out _))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetSecurityDescriptorGroup failed");
                if (!GetSecurityDescriptorDacl(descriptor, out bool daclPresent, out IntPtr dacl, out _))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "GetSecurityDescriptorDacl failed");
                if (!daclPresent) throw new InvalidOperationException("Refusing to restore an absent DACL");
                using SafeFileHandle handle = Open(path, true, READ_CONTROL | WRITE_DAC | WRITE_OWNER);
                uint requested = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
                uint error = SetSecurityInfo(handle.DangerousGetHandle(), SE_FILE_OBJECT, requested,
                    owner, group, dacl, IntPtr.Zero);
                if (error != 0) throw new Win32Exception((int)error, "SetSecurityInfo failed");
            }
            finally
            {
                if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            }
        }

        public static void RemoveJunctionNoRedirects(string path)
        {
            if (!RemoveDirectory2W(Extended(path), DIRECTORY_FLAGS_DISALLOW_PATH_REDIRECTS))
                throw new Win32Exception(Marshal.GetLastWin32Error(), $"RemoveDirectory2W failed for {path}");
        }
    }
}
'@
}

function Get-NormalizedLiteralPath {
  param([Parameter(Mandatory)][string]$Path)
  if ($Path.IndexOf([char]0) -ge 0) { throw '路径包含 NUL 字符' }
  if ($Path -ne $Path.Trim()) { throw "路径包含首尾空白：$Path" }
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  if ([string]::Equals($full, $root, [StringComparison]::OrdinalIgnoreCase)) { return $root }
  return $full.TrimEnd('\', '/')
}

function ConvertFrom-ReparseTarget {
  param([Parameter(Mandatory)][string]$Target)
  $value = $Target
  if ($value.StartsWith('\??\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
    $value = '\\' + $value.Substring(8)
  } elseif ($value.StartsWith('\??\', [StringComparison]::OrdinalIgnoreCase)) {
    $value = $value.Substring(4)
  } elseif ($value.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) {
    $value = '\\' + $value.Substring(8)
  } elseif ($value.StartsWith('\\?\', [StringComparison]::OrdinalIgnoreCase)) {
    $value = $value.Substring(4)
  }
  return Get-NormalizedLiteralPath $value
}

function Test-IdentityEqual {
  param($Left, $Right)
  return $null -ne $Left -and $null -ne $Right `
    -and [uint64]$Left.VolumeSerialNumber -eq [uint64]$Right.VolumeSerialNumber `
    -and [string]::Equals([string]$Left.FileId, [string]$Right.FileId, [StringComparison]::OrdinalIgnoreCase)
}

function Get-JunctionEvidence {
  param([Parameter(Mandatory)][string]$Path)
  $exact = Get-NormalizedLiteralPath $Path
  $native = [MerchRoute.JunctionRetirement.NativeFs]::GetMountPointIdentity($exact)
  $target = ConvertFrom-ReparseTarget $native.SubstituteName
  [pscustomobject]@{
    Path = $exact
    Target = $target
    PrintName = $native.PrintName
    ReparseTag = ('0x{0:x8}' -f $native.ReparseTag)
    VolumeSerialNumber = [uint64]$native.VolumeSerialNumber
    FileId = $native.FileId
    Sddl = $native.Sddl
  }
}

function Get-TargetEvidence {
  param([Parameter(Mandatory)][string]$Path)
  $exact = Get-NormalizedLiteralPath $Path
  $native = [MerchRoute.JunctionRetirement.NativeFs]::GetFileIdentity($exact, $true)
  if ($native.IsReparsePoint) { throw "真实目标不能是 reparse point：$exact" }
  if (-not [IO.Directory]::Exists($exact)) { throw "真实目标不是目录：$exact" }
  [pscustomobject]@{
    Path = $exact
    VolumeSerialNumber = [uint64]$native.VolumeSerialNumber
    FileId = $native.FileId
    Attributes = [uint32]$native.Attributes
  }
}

function Assert-ExactLegacyJunction {
  param([string]$Path = $script:LegacyPath)
  if (-not [string]::Equals((Get-NormalizedLiteralPath $Path), $script:LegacyPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝检查非固定 Junction：$Path"
  }
  $junction = Get-JunctionEvidence $Path
  if ($junction.ReparseTag -ne '0xa0000003') { throw "对象不是 Junction：$($junction.ReparseTag)" }
  if (-not [string]::Equals($junction.Target, $script:TargetPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Junction Target 不匹配：$($junction.Target)"
  }
  $target = Get-TargetEvidence $script:TargetPath
  $followed = [MerchRoute.JunctionRetirement.NativeFs]::GetFileIdentity($Path, $false)
  if (-not (Test-IdentityEqual $followed $target)) { throw 'Junction 实际解析对象与固定目标 File ID 不一致' }
  return [pscustomobject]@{ Junction = $junction; Target = $target }
}

function Assert-QuarantinePath {
  param([Parameter(Mandatory)][string]$Path)
  $exact = Get-NormalizedLiteralPath $Path
  if ($exact -notmatch '^G:\\01_n8n-global\.__quarantine__\d{8}-\d{6}$') {
    throw "隔离路径格式不合法：$exact"
  }
  if (-not [string]::Equals([IO.Path]::GetDirectoryName($exact), 'G:\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '隔离对象必须与旧 Junction 位于同一卷根目录'
  }
  return $exact
}

function Assert-QuarantinedJunction {
  param([Parameter(Mandatory)][string]$Path, $ExpectedJunction, $ExpectedTarget)
  $exact = Assert-QuarantinePath $Path
  $junction = Get-JunctionEvidence $exact
  if ($junction.ReparseTag -ne '0xa0000003' -or
      -not [string]::Equals($junction.Target, $script:TargetPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw '隔离对象不再是指向固定目标的 Junction'
  }
  if ($ExpectedJunction -and -not (Test-IdentityEqual $junction $ExpectedJunction)) {
    throw '隔离 Junction 的 File ID 已变化'
  }
  $target = Get-TargetEvidence $script:TargetPath
  if ($ExpectedTarget -and -not (Test-IdentityEqual $target $ExpectedTarget)) {
    throw '真实目标的 File ID 已变化'
  }
  return [pscustomobject]@{ Junction = $junction; Target = $target }
}

function Assert-RecoveryPointPath {
  param([Parameter(Mandatory)][string]$Path, [switch]$MustExist)
  $exact = Get-NormalizedLiteralPath $Path
  $base = Get-NormalizedLiteralPath $script:BackupBase
  $parent = [IO.Path]::GetDirectoryName($exact)
  $leaf = [IO.Path]::GetFileName($exact)
  if (-not [string]::Equals($parent, $base, [StringComparison]::OrdinalIgnoreCase) -or
      $leaf -notmatch '^\d{8}-\d{6}$') {
    throw "恢复点必须是 $base 下的时间戳直接子目录：$exact"
  }
  if ($MustExist -and -not [IO.Directory]::Exists($exact)) { throw "恢复点不存在：$exact" }
  return $exact
}

function Assert-RecoveryChild {
  param([Parameter(Mandatory)][string]$RecoveryPoint, [Parameter(Mandatory)][string]$Path)
  $root = (Assert-RecoveryPointPath $RecoveryPoint -MustExist) + '\'
  $exact = Get-NormalizedLiteralPath $Path
  if (-not $exact.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "目标不在恢复点内：$exact"
  }
  return $exact
}

function New-RestrictedRecoveryPoint {
  param([Parameter(Mandatory)][string]$Path)
  $exact = Assert-RecoveryPointPath $Path
  if ([IO.Directory]::Exists($exact) -or [IO.File]::Exists($exact)) { throw "恢复点已存在：$exact" }
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $runtimeSid = $current.User
  foreach ($owner in @(Get-ListeningPortOwners)) {
    if ($owner.OwnerSid -and $owner.OwnerSid -ne $runtimeSid.Value) {
      throw "运行账户 $($owner.OwnerSid) 与备份执行账户 $($runtimeSid.Value) 不一致"
    }
  }
  $parent = [IO.Path]::GetDirectoryName($exact)
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  [IO.Directory]::CreateDirectory($exact) | Out-Null
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($runtimeSid)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  $rights = [Security.AccessControl.FileSystemRights]::FullControl
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($runtimeSid, $rights, $inheritance, $propagation, $allow))
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, $rights, $inheritance, $propagation, $allow))
  Set-Acl -LiteralPath $exact -AclObject $acl
  Assert-RestrictedAcl $exact
  return $exact
}

function Assert-RestrictedAcl {
  param([Parameter(Mandatory)][string]$Path, [switch]$AllowInherited)
  $allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [void]$allowed.Add([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  [void]$allowed.Add('S-1-5-18')
  $acl = Get-Acl -LiteralPath $Path
  if (-not $AllowInherited -and -not $acl.AreAccessRulesProtected) { throw "恢复点 ACL 仍继承：$Path" }
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if (-not $allowed.Contains($sid)) { throw "恢复点 ACL 含未授权 SID $sid：$Path" }
  }
}

function Set-RestrictedRuntimeFileAcl {
  param([Parameter(Mandatory)][string]$Path)
  if (-not [IO.File]::Exists($Path)) { throw "运行配置文件不存在：$Path" }
  $runtimeSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  # Set-Acl with a newly-created FileSecurity object attempts to persist SACL
  # sections and requires SeSecurityPrivilege. icacls changes only the DACL:
  # inherited entries are removed, then the exact runtime and SYSTEM SIDs are
  # granted FullControl. Assert-RestrictedAcl independently reads it back.
  & icacls.exe $Path /inheritance:r /grant:r "*$($runtimeSid):(F)" '*S-1-5-18:(F)' /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "运行配置文件 ACL 收紧失败：$Path" }
  Assert-RestrictedAcl $Path
}

function Assert-TaskWorktreeReleaseReady {
  $branch = (& git -C $script:ProjectRoot branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $branch -or $branch -eq 'main') { throw '脚本必须从非 main 的任务 worktree 运行' }
  $head = (& git -C $script:ProjectRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[a-f0-9]{40}$') { throw '无法读取任务 worktree HEAD' }
  $status = @(& git -C $script:ProjectRoot status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0) { throw '无法读取任务 worktree 状态' }
  if ($status.Count -gt 0) { throw '任务 worktree 仍有未提交或未跟踪文件，拒绝用于备份/部署' }
  $buildInfoPath = Join-Path $script:ProjectRoot 'apps\server\dist\build-info.json'
  if (-not [IO.File]::Exists($buildInfoPath)) { throw '任务 worktree 尚未生成 server build-info.json' }
  $buildInfo = Get-Content -Raw -LiteralPath $buildInfoPath | ConvertFrom-Json -Depth 20
  if ($buildInfo.dirty -or -not [string]::Equals([string]$buildInfo.commitSha, $head, [StringComparison]::OrdinalIgnoreCase)) {
    throw "构建产物不是当前干净 HEAD：build=$($buildInfo.commitSha) head=$head dirty=$($buildInfo.dirty)"
  }
  $bundledToolchain = Join-Path $script:ProjectRoot '.tools\node-v22.23.1-win-x64'
  $bundledNode = Join-Path $bundledToolchain 'node.exe'
  $bundledNpm = Join-Path $bundledToolchain 'npm.cmd'
  if (-not [IO.File]::Exists($bundledNode) -or -not [IO.File]::Exists($bundledNpm)) {
    throw '任务 worktree 缺少固定 Node.js 22.23.1 / npm 10.9.8 工具链'
  }
  $nodeVersion = (& $bundledNode -p 'process.versions.node').Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne '22.23.1') { throw "任务 worktree Node.js 版本不匹配：$nodeVersion" }
  $npmVersion = (& $bundledNpm --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $npmVersion -ne '10.9.8') { throw "任务 worktree npm 版本不匹配：$npmVersion" }
  return [pscustomobject]@{
    Branch = $branch
    Head = $head
    BuildInfo = $buildInfo
    Toolchain = [pscustomobject]@{ Node = $nodeVersion; Npm = $npmVersion; Root = $bundledToolchain }
  }
}

function Assert-StateMatchesRelease {
  param([Parameter(Mandatory)]$State)
  $release = Assert-TaskWorktreeReleaseReady
  if (-not [string]::Equals([string]$State.projectRoot, $script:ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$State.branch, [string]$release.Branch, [StringComparison]::Ordinal) -or
      -not [string]::Equals([string]$State.head, [string]$release.Head, [StringComparison]::OrdinalIgnoreCase)) {
    throw '当前任务 worktree 与 Prepare 恢复点记录的分支/HEAD 不一致'
  }
  return $release
}

function Get-SafeTreeInventory {
  param([Parameter(Mandatory)][string]$Root)
  $rootPath = Get-NormalizedLiteralPath $Root
  $target = Get-TargetEvidence $rootPath
  $stack = [Collections.Generic.Stack[string]]::new()
  $stack.Push($rootPath)
  $files = [Collections.Generic.List[object]]::new()
  [long]$bytes = 0
  [long]$directories = 1
  while ($stack.Count -gt 0) {
    $directory = $stack.Pop()
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes = [IO.File]::GetAttributes($entry)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "备份源中包含 reparse point，拒绝静默跳过：$entry"
      }
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        $directories += 1
        $stack.Push($entry)
      } else {
        $info = [IO.FileInfo]::new($entry)
        $relative = [IO.Path]::GetRelativePath($rootPath, $entry)
        $files.Add([pscustomobject]@{
          RelativePath = $relative
          Length = [long]$info.Length
          LastWriteUtcTicks = [long]$info.LastWriteTimeUtc.Ticks
        })
        $bytes += [long]$info.Length
      }
    }
  }
  [pscustomobject]@{
    Root = $rootPath
    Identity = $target
    FileCount = [long]$files.Count
    DirectoryCount = $directories
    TotalBytes = $bytes
    Files = @($files | Sort-Object RelativePath)
  }
}

function Get-InventorySummary {
  param($Inventory)
  [pscustomobject]@{
    Root = $Inventory.Root
    Identity = $Inventory.Identity
    FileCount = $Inventory.FileCount
    DirectoryCount = $Inventory.DirectoryCount
    TotalBytes = $Inventory.TotalBytes
  }
}

function Assert-BackupCapacity {
  param([Parameter(Mandatory)][long]$SourceBytes)
  $drive = [IO.DriveInfo]::new('D')
  # Keep 15% copy headroom plus 20 GiB for two generations of logical dumps,
  # workflow exports, ACL evidence, logs, and restore rehearsal.
  [long]$required = [long]([Math]::Ceiling($SourceBytes * 1.15)) + 20GB
  if ($drive.AvailableFreeSpace -lt $required) {
    throw "D: 可用空间不足：required=$required available=$($drive.AvailableFreeSpace)"
  }
  [pscustomobject]@{ RequiredBytes = $required; AvailableBytes = [long]$drive.AvailableFreeSpace }
}

function Compare-TreeMirror {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination,
    [int]$HashSampleCount = 32
  )
  $sourceInventory = Get-SafeTreeInventory $Source
  $destinationInventory = Get-SafeTreeInventory $Destination
  if ($sourceInventory.FileCount -ne $destinationInventory.FileCount -or
      $sourceInventory.TotalBytes -ne $destinationInventory.TotalBytes -or
      $sourceInventory.DirectoryCount -ne $destinationInventory.DirectoryCount) {
    throw "镜像计数不一致：$Source -> $Destination"
  }
  $destinationMap = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($file in $destinationInventory.Files) { $destinationMap.Add($file.RelativePath, $file) }
  foreach ($file in $sourceInventory.Files) {
    if (-not $destinationMap.ContainsKey($file.RelativePath)) { throw "备份缺少文件：$($file.RelativePath)" }
    $copy = $destinationMap[$file.RelativePath]
    if ($copy.Length -ne $file.Length -or $copy.LastWriteUtcTicks -ne $file.LastWriteUtcTicks) {
      throw "备份文件属性不一致：$($file.RelativePath)"
    }
  }
  if ($sourceInventory.Files.Count -gt 0) {
    $step = [Math]::Max(1, [Math]::Floor($sourceInventory.Files.Count / [Math]::Max(1, $HashSampleCount)))
    $sampled = for ($index = 0; $index -lt $sourceInventory.Files.Count; $index += $step) {
      $sourceInventory.Files[$index]
    }
    foreach ($file in @($sampled | Select-Object -First $HashSampleCount)) {
      $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Source $file.RelativePath)).Hash
      $destinationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Destination $file.RelativePath)).Hash
      if ($sourceHash -ne $destinationHash) { throw "备份抽样哈希不一致：$($file.RelativePath)" }
    }
  }
  return Get-InventorySummary $sourceInventory
}

function Invoke-RestoreRehearsal {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Backup,
    [Parameter(Mandatory)][string]$RecoveryPoint,
    [Parameter(Mandatory)][string]$Label
  )
  $inventory = Get-SafeTreeInventory $Source
  if ($inventory.Files.Count -eq 0) { return [pscustomobject]@{ Label = $Label; Files = @() } }
  $indices = Get-RestoreRehearsalIndices $inventory.Files.Count
  $results = @()
  foreach ($index in $indices) {
    $entry = $inventory.Files[[int]$index]
    $backupFile = Join-Path $Backup $entry.RelativePath
    $restoredFile = Assert-RecoveryChild $RecoveryPoint (Join-Path $RecoveryPoint "restore-rehearsal\$Label\$($entry.RelativePath)")
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($restoredFile)) | Out-Null
    if ([IO.File]::Exists($restoredFile)) { throw "恢复抽查目标已存在：$restoredFile" }
    [IO.File]::Copy($backupFile, $restoredFile, $false)
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Source $entry.RelativePath)).Hash
    $restoredHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $restoredFile).Hash
    if ($sourceHash -ne $restoredHash) { throw "恢复抽查哈希不一致：$($entry.RelativePath)" }
    $results += [pscustomobject]@{ RelativePath = $entry.RelativePath; Sha256 = $sourceHash }
  }
  [pscustomobject]@{ Label = $Label; Files = $results }
}

function Get-RestoreRehearsalIndices {
  param([Parameter(Mandatory)][ValidateRange(0, [int]::MaxValue)][int]$FileCount)
  if ($FileCount -eq 0) { return @() }
  return @(0, [Math]::Floor(($FileCount - 1) / 2), ($FileCount - 1)) | Sort-Object -Unique
}

function Invoke-RobocopyMirror {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination,
    [Parameter(Mandatory)][string]$RecoveryPoint,
    [Parameter(Mandatory)][string]$Label,
    [switch]$Final
  )
  [void](Get-TargetEvidence $Source)
  $destinationPath = Assert-RecoveryChild $RecoveryPoint $Destination
  [IO.Directory]::CreateDirectory($destinationPath) | Out-Null
  [void](Get-SafeTreeInventory $Source) # Fails instead of allowing /XJ to hide reparse content.
  $log = Assert-RecoveryChild $RecoveryPoint (Join-Path $RecoveryPoint "logs\robocopy-$Label.log")
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($log)) | Out-Null
  $arguments = @(
    $Source, $destinationPath, '/MIR', '/COPY:DAT', '/DCOPY:DAT',
    # /Z is restartable under the actual runtime account. /ZB is deliberately
    # avoided because its backup-mode fallback requires SeBackupPrivilege and
    # makes an otherwise readable source fail with Robocopy exit code 16.
    '/XJ', '/R:2', '/W:2', '/Z', '/J', '/MT:8', '/NP', "/LOG:$log"
  )
  & robocopy.exe @arguments | Out-Null
  $code = $LASTEXITCODE
  if ($code -ge 8) { throw "Robocopy $Label 失败，退出码 $code" }
  if ($Final) {
    & robocopy.exe $Source $destinationPath /MIR /L /COPY:DAT /DCOPY:DAT /XJ /R:0 /W:0 /NFL /NDL /NP /NJH /NJS | Out-Null
    $verificationCode = $LASTEXITCODE
    if ($verificationCode -ne 0) { throw "Robocopy $Label 最终 dry-run 仍有差异，退出码 $verificationCode" }
    $mirror = Compare-TreeMirror $Source $destinationPath
    $rehearsal = Invoke-RestoreRehearsal $Source $destinationPath $RecoveryPoint $Label
    return [pscustomobject]@{ Mirror = $mirror; RestoreRehearsal = $rehearsal }
  }
  return [pscustomobject]@{ Source = $Source; Destination = $destinationPath; RobocopyExitCode = $code }
}

function Copy-ProtectedFile {
  param([string]$Source, [string]$Destination, [string]$RecoveryPoint)
  if (-not [IO.File]::Exists($Source)) { throw "备份文件不存在：$Source" }
  $destinationPath = Assert-RecoveryChild $RecoveryPoint $Destination
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destinationPath)) | Out-Null
  if ([IO.File]::Exists($destinationPath)) { throw "拒绝覆盖恢复点文件：$destinationPath" }
  [IO.File]::Copy($Source, $destinationPath, $false)
  $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Source).Hash
  $destinationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destinationPath).Hash
  if ($sourceHash -ne $destinationHash) { throw "备份文件哈希不一致：$Source" }
  [pscustomobject]@{ Source = $Source; Destination = $destinationPath; Sha256 = $sourceHash }
}

function Write-JsonAtomic {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
  $parent = [IO.Path]::GetDirectoryName($Path)
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $temporary = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  $json = $Value | ConvertTo-Json -Depth 100
  [IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporary, $Path, $true)
}

function Read-State {
  param([Parameter(Mandatory)][string]$RecoveryPoint)
  $root = Assert-RecoveryPointPath $RecoveryPoint -MustExist
  $path = Join-Path $root $script:StateFileName
  if (-not [IO.File]::Exists($path)) { throw "恢复点缺少 state.json：$root" }
  return Get-Content -Raw -LiteralPath $path | ConvertFrom-Json -Depth 100
}

function Write-State {
  param([Parameter(Mandatory)][string]$RecoveryPoint, [Parameter(Mandatory)]$State)
  $root = Assert-RecoveryPointPath $RecoveryPoint -MustExist
  Write-JsonAtomic (Join-Path $root $script:StateFileName) $State
}

function Get-DotEnvMap {
  param([Parameter(Mandatory)][string]$Path)
  if (-not [IO.File]::Exists($Path)) { throw "环境文件不存在：$Path" }
  $result = @{}
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    $text = $line.Trim()
    if (-not $text -or $text.StartsWith('#')) { continue }
    if ($text.StartsWith('export ')) { $text = $text.Substring(7).TrimStart() }
    $separator = $text.IndexOf('=')
    if ($separator -lt 1) { continue }
    $key = $text.Substring(0, $separator).Trim()
    if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { continue }
    $value = $text.Substring($separator + 1).Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $result[$key] = $value
  }
  return $result
}

function Get-MerchRoutePgConnection {
  $environment = Get-DotEnvMap $script:MerchRouteEnvPath
  if (-not $environment.ContainsKey('DATABASE_URL')) { throw 'merchroute.env 缺少 DATABASE_URL' }
  $uri = [Uri]$environment.DATABASE_URL
  $userinfo = $uri.UserInfo.Split(':', 2)
  if ($userinfo.Count -ne 2) { throw 'DATABASE_URL 缺少用户名或密码' }
  $sslMode = 'prefer'
  if ($uri.Query -match '(?:^|[?&])sslmode=([^&]+)') { $sslMode = [Uri]::UnescapeDataString($Matches[1]) }
  [pscustomobject]@{
    Host = $uri.Host
    Port = if ($uri.Port -gt 0) { [string]$uri.Port } else { '5432' }
    User = [Uri]::UnescapeDataString($userinfo[0])
    Password = [Uri]::UnescapeDataString($userinfo[1])
    Database = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
    SslMode = $sslMode
  }
}

function Get-N8nPgConnection {
  $environment = Get-DotEnvMap $script:N8nEnvPath
  function Pick([string[]]$Names, [string]$Default = '') {
    foreach ($name in $Names) { if ($environment.ContainsKey($name) -and $environment[$name]) { return $environment[$name] } }
    return $Default
  }
  [pscustomobject]@{
    Host = Pick @('DB_POSTGRESDB_HOST', 'N8N_DB_POSTGRESDB_HOST') '127.0.0.1'
    Port = Pick @('DB_POSTGRESDB_PORT', 'N8N_DB_POSTGRESDB_PORT') '5432'
    User = Pick @('DB_POSTGRESDB_USER', 'N8N_DB_POSTGRESDB_USER')
    Password = Pick @('DB_POSTGRESDB_PASSWORD', 'N8N_DB_POSTGRESDB_PASSWORD')
    Database = Pick @('DB_POSTGRESDB_DATABASE', 'N8N_DB_POSTGRESDB_DATABASE')
    SslMode = if ((Pick @('DB_POSTGRESDB_SSL_ENABLED', 'N8N_DB_POSTGRESDB_SSL_ENABLED')) -match '^(1|true|yes|on)$') { 'require' } else { 'disable' }
  }
}

function Remove-ProcessEnvironmentVariable {
  param([Parameter(Mandatory)][string]$Name)
  # Environment.SetEnvironmentVariable(name, $null, Process) leaves an empty
  # entry in this PowerShell host. The environment provider removes the entry
  # itself, which matters because libpq rejects an inherited PGSSLMODE=''.
  if (Test-Path -LiteralPath "Env:$Name") {
    $ExecutionContext.InvokeProvider.Item.Remove("Env:$Name", $false)
  }
}

function Invoke-WithPgEnvironment {
  param([Parameter(Mandatory)]$Connection, [Parameter(Mandatory)][scriptblock]$Operation)
  $keys = @('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE')
  $previous = @{}
  foreach ($key in $keys) {
    $previous[$key] = [pscustomobject]@{
      Exists = Test-Path -LiteralPath "Env:$key"
      Value = [Environment]::GetEnvironmentVariable($key, 'Process')
    }
  }
  try {
    $env:PGHOST = $Connection.Host
    $env:PGPORT = $Connection.Port
    $env:PGUSER = $Connection.User
    $env:PGPASSWORD = $Connection.Password
    $env:PGDATABASE = $Connection.Database
    if ($Connection.SslMode) { $env:PGSSLMODE = $Connection.SslMode } else { Remove-ProcessEnvironmentVariable 'PGSSLMODE' }
    & $Operation
  } finally {
    foreach ($key in $keys) {
      if ($previous[$key].Exists) {
        [Environment]::SetEnvironmentVariable($key, [string]$previous[$key].Value, 'Process')
      } else {
        Remove-ProcessEnvironmentVariable $key
      }
    }
  }
}

function Invoke-PgDumpValidated {
  param([Parameter(Mandatory)]$Connection, [Parameter(Mandatory)][string]$OutputPath)
  if ([IO.File]::Exists($OutputPath)) { throw "拒绝覆盖数据库备份：$OutputPath" }
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputPath)) | Out-Null
  $pgDump = 'D:\Program Files\PostgreSQL\18\bin\pg_dump.exe'
  $pgRestore = 'D:\Program Files\PostgreSQL\18\bin\pg_restore.exe'
  foreach ($tool in @($pgDump, $pgRestore)) { if (-not [IO.File]::Exists($tool)) { throw "缺少 PostgreSQL 工具：$tool" } }
  Invoke-WithPgEnvironment $Connection {
    & $pgDump --format=custom --compress=6 --no-password "--file=$OutputPath"
    if ($LASTEXITCODE -ne 0) { throw "pg_dump 失败：$OutputPath" }
    $tocPath = "$OutputPath.toc.txt"
    & $pgRestore --list $OutputPath | Set-Content -LiteralPath $tocPath -Encoding utf8NoBOM
    if ($LASTEXITCODE -ne 0 -or (Get-Item -LiteralPath $tocPath).Length -eq 0) { throw "pg_restore TOC 校验失败：$OutputPath" }
    & $pgRestore --file=NUL $OutputPath
    if ($LASTEXITCODE -ne 0) { throw "pg_restore 解包校验失败：$OutputPath" }
  }
  [pscustomobject]@{ Path = $OutputPath; Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash }
}

function Invoke-PsqlScalarJson {
  param([Parameter(Mandatory)]$Connection, [Parameter(Mandatory)][string]$Sql)
  $psql = 'D:\Program Files\PostgreSQL\18\bin\psql.exe'
  if (-not [IO.File]::Exists($psql)) { throw "缺少 psql：$psql" }
  $output = Invoke-WithPgEnvironment $Connection {
    & $psql --no-password --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command=$Sql
    if ($LASTEXITCODE -ne 0) { throw '只读门禁 SQL 执行失败' }
  }
  $text = (@($output) -join "`n").Trim()
  if (-not $text) { throw '只读门禁 SQL 未返回结果' }
  return $text | ConvertFrom-Json -Depth 50
}

function Get-N8nExecutionGate {
  param([switch]$AllowKnownE001StaleExecutions)
  $quotedIds = $script:EWorkflowIds | ForEach-Object { "'$_'" }
  $idList = $quotedIds -join ','
  $knownStalePredicate = @"
id BETWEEN 312359 AND 312430
    AND "workflowId" = 'Wxng7hVbjMNhVOaO'
    AND "workflowVersionId" = '17606e89-4ded-46a3-ac74-4d7c23c001a3'
    AND mode = 'trigger'
    AND status = 'new'
    AND finished = false
    AND "startedAt" IS NULL
    AND "stoppedAt" IS NULL
    AND "waitTill" IS NULL
    AND "deletedAt" IS NULL
"@
  # deletedAt IS NULL is mandatory: soft-deleted executions must never be counted as runnable work.
  $sql = @"
WITH active AS (
  SELECT id,status
  FROM execution_entity
  WHERE "deletedAt" IS NULL
    AND "workflowId" IN ($idList)
    AND status IN ('new','running','waiting')
), known_stale AS (
  SELECT id FROM execution_entity WHERE $knownStalePredicate
)
SELECT json_build_object(
  'activeCount', (SELECT COUNT(*)::int FROM active),
  'knownE001StaleCount', (SELECT COUNT(*)::int FROM known_stale),
  'knownE001StaleExactSet', (
    SELECT COALESCE(array_agg(id::bigint ORDER BY id), ARRAY[]::bigint[])
      = ARRAY(SELECT generate_series(312359::bigint, 312430::bigint))
    FROM known_stale
  ),
  'otherActiveCount', (
    SELECT COUNT(*)::int FROM active a
    WHERE NOT EXISTS (SELECT 1 FROM known_stale stale WHERE stale.id=a.id)
  ),
  'byState', COALESCE((SELECT json_object_agg(status,state_count) FROM (
    SELECT status,COUNT(*)::int state_count FROM active GROUP BY status
  ) grouped), '{}'::json)
);
"@
  $result = Invoke-PsqlScalarJson (Get-N8nPgConnection) $sql
  if ($AllowKnownE001StaleExecutions) {
    $knownSetIsIntact = [int]$result.knownE001StaleCount -eq 72 -and [bool]$result.knownE001StaleExactSet
    $allActiveExecutionsAreGone = [int]$result.activeCount -eq 0
    if ((-not $knownSetIsIntact -and -not $allActiveExecutionsAreGone) -or [int]$result.otherActiveCount -ne 0) {
      throw "n8n 非终态执行不再精确等于已审计的 72 条 E001 遗留项：known=$($result.knownE001StaleCount) other=$($result.otherActiveCount)"
    }
  } elseif ([int]$result.activeCount -ne 0) {
    throw "E001-E007 仍有 n8n 非终态执行：$($result.activeCount)"
  }
  return $result
}

function Cancel-KnownE001StaleExecutions {
  $gate = Get-N8nExecutionGate -AllowKnownE001StaleExecutions
  if ([int]$gate.activeCount -eq 0) {
    $alreadyCanceledSql = @"
SELECT json_build_object(
  'alreadyCanceled', true,
  'matchedCount', COUNT(*)::int,
  'exactSet', COALESCE(array_agg(id::bigint ORDER BY id), ARRAY[]::bigint[])
    = ARRAY(SELECT generate_series(312359::bigint, 312430::bigint))
)
FROM execution_entity
WHERE id BETWEEN 312359 AND 312430
  AND "workflowId" = 'Wxng7hVbjMNhVOaO'
  AND "workflowVersionId" = '17606e89-4ded-46a3-ac74-4d7c23c001a3'
  AND mode = 'trigger'
  AND status = 'canceled'
  AND finished = false
  AND "startedAt" IS NULL
  AND "stoppedAt" IS NOT NULL
  AND "waitTill" IS NULL
  AND "deletedAt" IS NULL;
"@
    $alreadyCanceled = Invoke-PsqlScalarJson (Get-N8nPgConnection) $alreadyCanceledSql
    if ([int]$alreadyCanceled.matchedCount -ne 72 -or -not [bool]$alreadyCanceled.exactSet) {
      throw "E001 遗留 execution 已无活动项，但取消后状态未精确匹配 72 行：matched=$($alreadyCanceled.matchedCount)"
    }
    return $alreadyCanceled
  }
  $sql = @"
WITH locked AS MATERIALIZED (
  SELECT id
  FROM execution_entity
  WHERE id BETWEEN 312359 AND 312430
    AND "workflowId" = 'Wxng7hVbjMNhVOaO'
    AND "workflowVersionId" = '17606e89-4ded-46a3-ac74-4d7c23c001a3'
    AND mode = 'trigger'
    AND status = 'new'
    AND finished = false
    AND "startedAt" IS NULL
    AND "stoppedAt" IS NULL
    AND "waitTill" IS NULL
    AND "deletedAt" IS NULL
  FOR UPDATE
), guard AS (
  SELECT COALESCE(array_agg(id::bigint ORDER BY id), ARRAY[]::bigint[])
    = ARRAY(SELECT generate_series(312359::bigint, 312430::bigint)) AS exact_set
  FROM locked
), updated AS (
  UPDATE execution_entity entity
  SET status='canceled',"stoppedAt"=clock_timestamp(),"waitTill"=NULL
  FROM guard
  WHERE guard.exact_set
    AND entity.id IN (SELECT id FROM locked)
    AND entity.status='new'
    AND entity."deletedAt" IS NULL
  RETURNING entity.id
)
SELECT json_build_object(
  'alreadyCanceled', false,
  'matchedCount', (SELECT COUNT(*)::int FROM locked),
  'exactSet', (SELECT exact_set FROM guard),
  'updatedCount', (SELECT COUNT(*)::int FROM updated)
);
"@
  $result = Invoke-PsqlScalarJson (Get-N8nPgConnection) $sql
  if ([int]$result.matchedCount -ne 72 -or -not [bool]$result.exactSet -or [int]$result.updatedCount -ne 72) {
    throw "E001 遗留 execution CAS 未精确更新 72 行：matched=$($result.matchedCount) updated=$($result.updatedCount)"
  }
  return $result
}

function Get-MerchRouteDatabaseGate {
  $sql = @"
SELECT json_build_object(
  'downloadActive', (SELECT COUNT(*)::int FROM download_jobs WHERE status IN ('QUEUED','WAITING_RESOURCE','RUNNING')),
  'downloadLeases', (SELECT COUNT(*)::int FROM download_jobs WHERE lease_expires_at > NOW()),
  'wbActive', (SELECT COUNT(*)::int FROM wb_publish_jobs WHERE finished_at IS NULL AND state NOT IN ('SUCCEEDED','FAILED','NEEDS_ATTENTION','BLOCKED_AUTH','BLOCKED_CONFIG','BLOCKED_SCHEMA','BLOCKED_COMPLIANCE','BLOCKED_EXISTING_CARD','PAUSED','CANCELLED')),
  'wbLeases', (SELECT COUNT(*)::int FROM wb_publish_jobs WHERE lease_expires_at > NOW()),
  'ozonActive', (SELECT COUNT(*)::int FROM ozon_publish_jobs WHERE state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')),
  'ozonLeases', (SELECT COUNT(*)::int FROM ozon_publish_jobs WHERE lease_expires_at > NOW()),
  'ozonSlots', (SELECT COUNT(*)::int FROM ozon_publish_slots WHERE lease_expires_at > NOW()),
  'ozonRefreshLeases', (SELECT COUNT(*)::int FROM ozon_platform_status_refresh_leases WHERE lease_expires_at > NOW()),
  'wbCleanupInFlight', (SELECT COUNT(*)::int FROM wb_source_media_cleanup_batches WHERE status='QUARANTINED'),
  'wbCleanupLeases', (SELECT COUNT(*)::int FROM wb_source_media_cleanup_batches WHERE lease_expires_at > NOW()),
  'ozonCleanupInFlight', (SELECT COUNT(*)::int FROM ozon_source_media_cleanup_batches WHERE state IN ('QUARANTINING','QUARANTINED')),
  'ozonCleanupLeases', (SELECT COUNT(*)::int FROM ozon_source_media_cleanup_batches WHERE lease_expires_at > NOW()),
  'advisoryLocks', (SELECT COUNT(*)::int FROM pg_locks WHERE locktype='advisory' AND granted)
);
"@
  $result = Invoke-PsqlScalarJson (Get-MerchRoutePgConnection) $sql
  foreach ($property in $result.PSObject.Properties) {
    if ([int]$property.Value -ne 0) { throw "MerchRoute 数据库门禁未清空：$($property.Name)=$($property.Value)" }
  }
  return $result
}

function Get-LegacyCompatibilityReadiness {
  $response = Invoke-RestMethod -Method Get -Uri ("http://127.0.0.1:$script:MerchRoutePort/api/v1/config") -TimeoutSec 10
  if (-not $response.readiness.complete) { throw 'MerchRoute readiness 不完整' }
  $legacy = $response.readiness.legacyRootCompatibility
  if (-not $legacy -or $legacy.status -ne 'READY' -or -not $legacy.mappingSelfTest -or -not $legacy.canonicalRootReady) {
    throw 'legacyRootCompatibility 未达到 READY'
  }
  if (-not [string]::Equals([string]$legacy.legacyRoot, $script:LegacyPath, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$legacy.canonicalRoot, $script:TargetPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'legacyRootCompatibility 根路径不匹配'
  }
  return $legacy
}

function Assert-LiveRuntimeMatchesRelease {
  param([Parameter(Mandatory)]$Release)
  $version = Invoke-RestMethod -Method Get -Uri ("http://127.0.0.1:$script:MerchRoutePort/api/v1/about/version") -TimeoutSec 30
  if (-not [string]::Equals([string]$version.current.commitSha, [string]$Release.Head, [StringComparison]::OrdinalIgnoreCase) -or
      [bool]$version.current.dirty) {
    throw "当前 MerchRoute 运行构建不是任务分支干净 HEAD：runtime=$($version.current.commitSha) expected=$($Release.Head) dirty=$($version.current.dirty)"
  }
  return $version.current
}

function Assert-LiveAppDataPath {
  param([Parameter(Mandatory)]$Health)
  if (-not $Health.appDataDir) { throw 'MerchRoute health 未报告 appDataDir' }
  $actual = Get-NormalizedLiteralPath ([string]$Health.appDataDir)
  $expected = Get-NormalizedLiteralPath $script:MerchRouteAppDataPath
  if (-not [string]::Equals($actual, $expected, [StringComparison]::OrdinalIgnoreCase)) {
    throw "MerchRoute 实际 AppData 与退役脚本保护路径不一致：actual=$actual expected=$expected"
  }
  if (-not [IO.Directory]::Exists($actual)) { throw "MerchRoute 实际 AppData 不存在：$actual" }
  return $actual
}

function Get-HealthGate {
  $n8n = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5678/healthz' -TimeoutSec 10
  $merchRoute = Invoke-RestMethod -Method Get -Uri ("http://127.0.0.1:$script:MerchRoutePort/api/v1/health") -TimeoutSec 10
  if ($n8n.StatusCode -ne 200 -or $merchRoute.status -ne 'ok') { throw '健康检查未返回 200/ok' }
  $appDataPath = Assert-LiveAppDataPath $merchRoute
  [pscustomobject]@{ N8nStatus = $n8n.StatusCode; MerchRouteStatus = 200; AppDataPath = $appDataPath }
}

function Get-ListeningPortOwners {
  $result = @()
  foreach ($port in @($script:MerchRoutePort, 5678, 5679)) {
    foreach ($connection in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
      $owner = if ($process) { Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid } else { $null }
      $result += [pscustomobject]@{
        Port = $port
        Pid = [int]$connection.OwningProcess
        Name = if ($process) { $process.Name } else { $null }
        CommandLine = if ($process) { $process.CommandLine } else { $null }
        OwnerSid = if ($owner) { $owner.Sid } else { $null }
        ParentProcessId = if ($process) { [int]$process.ParentProcessId } else { 0 }
        ExecutablePath = if ($process) { $process.ExecutablePath } else { $null }
      }
    }
  }
  return @($result)
}

function Assert-ExpectedPortOwners {
  param([object[]]$Owners, [switch]$RequireAllPorts)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($RequireAllPorts) {
    foreach ($requiredPort in @($script:MerchRoutePort, 5678, 5679)) {
      if (-not ($Owners | Where-Object Port -eq $requiredPort)) { throw "预期监听端口缺失：$requiredPort" }
    }
  }
  foreach ($owner in $Owners) {
    if ($owner.OwnerSid -ne $currentSid) { throw "端口 $($owner.Port) 不属于当前运行账户" }
    if ($owner.Name -ne 'node.exe') { throw "端口 $($owner.Port) 不是预期 Node 进程" }
    if ($owner.Port -eq $script:MerchRoutePort -and $owner.CommandLine -notmatch '(?i)(?:^|[\\/"\s])(?:apps[\\/]server[\\/])?dist[\\/]index\.js(?:$|["\s])') {
      throw "MerchRoute 端口 $script:MerchRoutePort 的命令行不是 dist/index.js"
    }
    if ($owner.Port -in @(5678, 5679) -and $owner.CommandLine -notmatch '(?i)(node_modules[\\/](?:n8n|@n8n)|[\\/]n8n[\\/]bin[\\/]n8n|task[-_ ]runner|runners)') {
      throw "端口 $($owner.Port) 命令行不是本机全局 n8n"
    }
  }
}

function Stop-VerifiedRuntime {
  param([switch]$AllowAlreadyStopped)
  $owners = @(Get-ListeningPortOwners)
  if ($owners.Count -eq 0 -and $AllowAlreadyStopped) { return @() }
  Assert-ExpectedPortOwners $owners -RequireAllPorts:(-not $AllowAlreadyStopped)
  foreach ($pidValue in @($owners.Pid | Sort-Object -Unique -Descending)) {
    Stop-Process -Id $pidValue -Force -ErrorAction Stop
  }
  $deadline = [DateTimeOffset]::Now.AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-ListeningPortOwners)
  } while ($remaining.Count -gt 0 -and [DateTimeOffset]::Now -lt $deadline)
  if ($remaining.Count -gt 0) { throw "$script:MerchRoutePort/5678/5679 未在 30 秒内全部退出" }
  return $owners
}

function Stop-VerifiedMerchRoute {
  $owners = @(Get-ListeningPortOwners | Where-Object Port -eq $script:MerchRoutePort)
  if ($owners.Count -ne 1) { throw "$script:MerchRoutePort 端口监听数量不是 1：$($owners.Count)" }
  Assert-ExpectedPortOwners $owners
  Stop-Process -Id $owners[0].Pid -Force -ErrorAction Stop
  $deadline = [DateTimeOffset]::Now.AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-ListeningPortOwners | Where-Object Port -eq $script:MerchRoutePort)
  } while ($remaining.Count -gt 0 -and [DateTimeOffset]::Now -lt $deadline)
  if ($remaining.Count -gt 0) { throw "$script:MerchRoutePort 未在 30 秒内退出" }
  return $owners[0]
}

function New-StartupLogCapture {
  param(
    [Parameter(Mandatory)][string]$RecoveryPoint,
    [Parameter(Mandatory)][ValidateSet('n8n', 'new', 'restored')][string]$Label
  )
  $root = Assert-RecoveryPointPath $RecoveryPoint -MustExist
  $logDirectory = Assert-RecoveryChild $root (Join-Path $root 'logs')
  [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
  $suffix = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([Guid]::NewGuid().ToString('N'))"
  return [pscustomobject]@{
    StandardOutput = Assert-RecoveryChild $root (Join-Path $logDirectory "startup-$Label-$suffix.stdout.log")
    StandardError = Assert-RecoveryChild $root (Join-Path $logDirectory "startup-$Label-$suffix.stderr.log")
  }
}

function Get-N8nRuntimeReadiness {
  param([object[]]$Owners)
  $ports = @($Owners | ForEach-Object { $_.Port } | Sort-Object -Unique)
  $pids = @($Owners | ForEach-Object { $_.Pid } | Sort-Object -Unique)
  return [pscustomobject]@{
    Ports = $ports
    Pids = $pids
    Ready = $ports.Count -eq 2 -and $pids.Count -eq 1
  }
}

function Test-N8nLauncherCommandLine {
  param([string]$CommandLine)
  if (-not $CommandLine) { return $false }
  $escapedPath = [Regex]::Escape($script:N8nLauncherPath)
  # Match the complete cmd.exe invocation, not merely a mention of the launcher.
  # The first alternative covers cmd.exe's outer-quote form: /c ""path" ".
  $pattern = '(?i)^\s*(?:"[^"]*\\cmd\.exe"|(?:[^\s"]*\\)?cmd\.exe)\s+(?:(?:/d|/s)\s+)*/c\s+(?:""{0}"\s*"|"{0}"|{0})\s*$' -f $escapedPath
  return $CommandLine -match $pattern
}

function Get-VerifiedN8nLauncherProcesses {
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $launchers = @()
  foreach ($process in @(Get-CimInstance Win32_Process | Where-Object Name -eq 'cmd.exe')) {
    $commandLine = [string]$process.CommandLine
    if (-not (Test-N8nLauncherCommandLine $commandLine)) { continue }
    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
    if (-not $owner -or $owner.Sid -ne $currentSid) {
      throw "n8n 启动器 PID $($process.ProcessId) 不属于当前运行账户"
    }
    $launchers += [pscustomobject]@{
      Pid = [int]$process.ProcessId
      ParentProcessId = [int]$process.ParentProcessId
      Name = [string]$process.Name
      CommandLine = $commandLine
      OwnerSid = [string]$owner.Sid
    }
  }
  return @($launchers)
}

function Stop-VerifiedN8nLaunchersWithoutListeners {
  $n8nOwners = @(Get-ListeningPortOwners | Where-Object Port -in @(5678, 5679))
  if ($n8nOwners.Count -gt 0) { return @() }
  $launchers = @(Get-VerifiedN8nLauncherProcesses)
  foreach ($launcher in $launchers) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($launcher.Pid)"
    if (-not $current) { continue }
    if ($current.Name -ne 'cmd.exe' -or
        -not [string]::Equals([string]$current.CommandLine, [string]$launcher.CommandLine, [StringComparison]::Ordinal) -or
        -not (Test-N8nLauncherCommandLine ([string]$current.CommandLine))) {
      throw "n8n 启动器 PID $($launcher.Pid) 在停止前发生身份变化"
    }
    $currentOwner = Invoke-CimMethod -InputObject $current -MethodName GetOwnerSid
    if (-not $currentOwner -or $currentOwner.Sid -ne $launcher.OwnerSid) {
      throw "n8n 启动器 PID $($launcher.Pid) 在停止前发生账户变化"
    }
    if (@(Get-ListeningPortOwners | Where-Object Port -in @(5678, 5679)).Count -gt 0) {
      throw '清理残留 n8n 启动器期间出现监听端口，拒绝继续停止进程'
    }
    Stop-Process -Id $launcher.Pid -Force -ErrorAction Stop
  }
  $deadline = [DateTimeOffset]::Now.AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-VerifiedN8nLauncherProcesses)
  } while ($remaining.Count -gt 0 -and [DateTimeOffset]::Now -lt $deadline)
  if ($remaining.Count -gt 0) { throw '无监听的 n8n 启动器未在 30 秒内退出' }
  return $launchers
}

function Start-N8nRuntime {
  param([Parameter(Mandatory)][string]$RecoveryPoint)
  $owners = @(Get-ListeningPortOwners | Where-Object Port -in @(5678, 5679))
  if ($owners.Count -gt 0) { Assert-ExpectedPortOwners $owners }
  $capture = $null
  if (-not ($owners | Where-Object Port -eq 5678)) {
    [void](Stop-VerifiedN8nLaunchersWithoutListeners)
    $capture = New-StartupLogCapture $RecoveryPoint 'n8n'
    $command = '"' + $script:N8nLauncherPath + '"'
    $connection = Get-N8nPgConnection
    $pgEnvironment = @{
      PGHOST = [string]$connection.Host
      PGPORT = [string]$connection.Port
      PGUSER = [string]$connection.User
      PGPASSWORD = [string]$connection.Password
      PGDATABASE = [string]$connection.Database
      PGSSLMODE = [string]$connection.SslMode
    }
    Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $command) `
      -WorkingDirectory $script:TargetPath -WindowStyle Hidden `
      -RedirectStandardOutput $capture.StandardOutput -RedirectStandardError $capture.StandardError `
      -Environment $pgEnvironment
  }
  $deadline = [DateTimeOffset]::Now.AddSeconds(180)
  do {
    Start-Sleep -Milliseconds 500
    $owners = @(Get-ListeningPortOwners | Where-Object Port -in @(5678, 5679))
    $readiness = Get-N8nRuntimeReadiness $owners
    $portsReady = $readiness.Ready
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5678/healthz' -TimeoutSec 3
      $healthReady = $response.StatusCode -eq 200
    } catch { $healthReady = $false }
  } while ((-not $portsReady -or -not $healthReady) -and [DateTimeOffset]::Now -lt $deadline)
  if (-not $portsReady -or -not $healthReady) {
    $logHint = if ($capture) { "；日志：$($capture.StandardOutput) / $($capture.StandardError)" } else { '' }
    throw "n8n 未在 180 秒内同时恢复 5678/5679 与 healthz$logHint"
  }
  Assert-ExpectedPortOwners $owners
  return [pscustomobject]@{ Status = 200; Pid = $readiness.Pids[0] }
}

function Start-NewRuntime {
  param([Parameter(Mandatory)][string]$RecoveryPoint)
  if (-not [IO.File]::Exists((Join-Path $script:ProjectRoot 'apps\server\dist\index.js'))) { throw '新 worktree 缺少已构建 server dist' }
  if (-not [IO.Directory]::Exists((Join-Path $script:ProjectRoot 'node_modules'))) { throw '新 worktree 缺少 node_modules' }
  $listening = @(Get-ListeningPortOwners)
  if ($listening.Count -gt 0) { Assert-ExpectedPortOwners $listening }
  [void](Start-N8nRuntime $RecoveryPoint)
  $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
  $arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start-windows.ps1')
  )
  $previous = $env:MERCHROUTE_ENV_FILE
  $previousNoOpenBrowser = $env:NO_OPEN_BROWSER
  $capture = New-StartupLogCapture $RecoveryPoint 'new'
  try {
    $env:MERCHROUTE_ENV_FILE = $script:MerchRouteEnvPath
    $env:NO_OPEN_BROWSER = '1'
    if (-not ($listening | Where-Object Port -eq $script:MerchRoutePort)) {
      Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $script:ProjectRoot -WindowStyle Hidden `
        -RedirectStandardOutput $capture.StandardOutput -RedirectStandardError $capture.StandardError
    }
  } finally {
    $env:MERCHROUTE_ENV_FILE = $previous
    $env:NO_OPEN_BROWSER = $previousNoOpenBrowser
  }
  $deadline = [DateTimeOffset]::Now.AddSeconds(180)
  do {
    Start-Sleep -Milliseconds 500
    try { $health = Get-HealthGate } catch { $health = $null }
  } while (-not $health -and [DateTimeOffset]::Now -lt $deadline)
  if (-not $health) {
    throw "新路径服务启动后健康检查超时；日志：$($capture.StandardOutput) / $($capture.StandardError)"
  }
  return $health
}

function Start-RestoredRuntime {
  param([Parameter(Mandatory)][string]$RecoveryPoint)
  $listening = @(Get-ListeningPortOwners)
  $capture = $null
  if ($listening.Count -gt 0) { Assert-ExpectedPortOwners $listening }
  [void](Start-N8nRuntime $RecoveryPoint)
  if (-not ($listening | Where-Object Port -eq $script:MerchRoutePort)) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($script:MerchRouteShortcutPath)
    $launcher = Get-NormalizedLiteralPath $shortcut.TargetPath
    if ($launcher -notmatch '(?i)\\scripts\\start-windows\.cmd$' -or
        $launcher.StartsWith($script:LegacyPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.File]::Exists($launcher)) {
      throw "恢复后的 Startup 入口不安全：$launcher"
    }
    $powerShellLauncher = [IO.Path]::ChangeExtension($launcher, '.ps1')
    if (-not [IO.File]::Exists($powerShellLauncher)) { throw "恢复后的 PowerShell 启动脚本不存在：$powerShellLauncher" }
    $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
    $capture = New-StartupLogCapture $RecoveryPoint 'restored'
    Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $powerShellLauncher) `
      -WorkingDirectory ([IO.Path]::GetDirectoryName($powerShellLauncher)) -WindowStyle Hidden `
      -RedirectStandardOutput $capture.StandardOutput -RedirectStandardError $capture.StandardError
  }
  $deadline = [DateTimeOffset]::Now.AddSeconds(180)
  do {
    Start-Sleep -Milliseconds 500
    try { $health = Get-HealthGate } catch { $health = $null }
  } while (-not $health -and [DateTimeOffset]::Now -lt $deadline)
  if (-not $health) {
    $logHint = if ($capture) { "；日志：$($capture.StandardOutput) / $($capture.StandardError)" } else { '' }
    throw "回滚运行入口启动后健康检查超时$logHint"
  }
  return $health
}

function Enter-Maintenance {
  param([Parameter(Mandatory)][string]$RecoveryPoint)
  $root = Assert-RecoveryPointPath $RecoveryPoint -MustExist
  if ([IO.File]::Exists($script:MaintenanceMarkerPath)) {
    $existing = Get-Content -Raw -LiteralPath $script:MaintenanceMarkerPath | ConvertFrom-Json -Depth 20
    if ($existing.reason -ne 'RETIRE_N8N_GLOBAL_JUNCTION' -or
        -not [string]::Equals([string]$existing.recoveryPoint, $root, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$existing.token -notmatch '^[a-f0-9]{32}$') {
      throw "维护标记不属于此恢复点，拒绝接管：$($script:MaintenanceMarkerPath)"
    }
    $script:MaintenanceToken = [string]$existing.token
  } else {
    Write-JsonAtomic $script:MaintenanceMarkerPath ([ordered]@{
      schemaVersion = 1
      reason = 'RETIRE_N8N_GLOBAL_JUNCTION'
      recoveryPoint = $root
      enteredAt = [DateTimeOffset]::Now.ToString('o')
      processId = $PID
      token = $script:MaintenanceToken
    })
  }
  try {
    $merchRouteOwners = @(Get-ListeningPortOwners | Where-Object Port -eq $script:MerchRoutePort)
    if ($merchRouteOwners.Count -eq 0) { return }
    $deadline = [DateTimeOffset]::Now.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 500
      try {
        $config = Invoke-RestMethod -Method Get -Uri ("http://127.0.0.1:$script:MerchRoutePort/api/v1/config") -TimeoutSec 3
        $maintenanceReady = $config.readiness.maintenanceMode -and $config.readiness.maintenanceMode.acceptingNewTasks -eq $false
      } catch { $maintenanceReady = $false }
    } while (-not $maintenanceReady -and [DateTimeOffset]::Now -lt $deadline)
    if (-not $maintenanceReady) { throw '应用未确认 maintenanceMode，拒绝继续切换' }
  } catch {
    $failure = $_.Exception
    try { Exit-Maintenance $root } catch { }
    throw $failure
  }
}

function Exit-Maintenance {
  param([Parameter(Mandatory)][string]$RecoveryPoint)
  if (-not [IO.File]::Exists($script:MaintenanceMarkerPath)) { return }
  $root = Assert-RecoveryPointPath $RecoveryPoint -MustExist
  $marker = Get-Content -Raw -LiteralPath $script:MaintenanceMarkerPath | ConvertFrom-Json -Depth 20
  if ($marker.token -ne $script:MaintenanceToken -or $marker.reason -ne 'RETIRE_N8N_GLOBAL_JUNCTION' -or
      -not [string]::Equals([string]$marker.recoveryPoint, $root, [StringComparison]::OrdinalIgnoreCase)) {
    throw '维护标记不属于当前恢复点，拒绝删除'
  }
  [IO.File]::Delete($script:MaintenanceMarkerPath)
}

function Wait-OperationalDrain {
  param(
    [TimeSpan]$Timeout = [TimeSpan]::FromMinutes(15),
    [switch]$AllowKnownE001StaleExecutions
  )
  $deadline = [DateTimeOffset]::Now.Add($Timeout)
  $consecutive = 0
  do {
    try {
      [void](Get-N8nExecutionGate -AllowKnownE001StaleExecutions:$AllowKnownE001StaleExecutions)
      [void](Get-MerchRouteDatabaseGate)
      $consecutive += 1
    } catch {
      $consecutive = 0
      if ([DateTimeOffset]::Now -ge $deadline) { throw }
    }
    if ($consecutive -lt 2) { Start-Sleep -Seconds 5 }
  } while ($consecutive -lt 2 -and [DateTimeOffset]::Now -lt $deadline)
  if ($consecutive -lt 2) { throw '维护门禁在 15 分钟内未连续两次清空' }
}

function Set-RuntimeCompatibilityEnvironment {
  param([Parameter(Mandatory)][string]$RecoveryPoint)
  $backup = Join-Path $RecoveryPoint 'external-config\merchroute.env.original'
  if (-not [IO.File]::Exists($backup)) { throw '未找到修改前的 merchroute.env 备份' }
  $lines = [Collections.Generic.List[string]]::new()
  foreach ($line in [IO.File]::ReadAllLines($script:MerchRouteEnvPath)) { $lines.Add($line) }
  $dataRootSeen = $false
  $legacySeen = $false
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    if ($lines[$index] -match '^\s*MERCHROUTE_DATA_ROOT\s*=') {
      $value = $lines[$index].Substring($lines[$index].IndexOf('=') + 1).Trim().Trim('"', "'")
      if (-not [string]::Equals((Get-NormalizedLiteralPath $value), $script:TargetPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'MERCHROUTE_DATA_ROOT 不是固定新根，拒绝覆盖'
      }
      $lines[$index] = "MERCHROUTE_DATA_ROOT=$($script:TargetPath)"
      $dataRootSeen = $true
    } elseif ($lines[$index] -match '^\s*MERCHROUTE_LEGACY_DATA_ROOT\s*=') {
      $lines[$index] = "MERCHROUTE_LEGACY_DATA_ROOT=$($script:LegacyPath)"
      $legacySeen = $true
    }
  }
  if (-not $dataRootSeen) { throw 'merchroute.env 缺少 MERCHROUTE_DATA_ROOT，拒绝自动补写目标根' }
  if (-not $legacySeen) { $lines.Add("MERCHROUTE_LEGACY_DATA_ROOT=$($script:LegacyPath)") }
  $temporary = "$($script:MerchRouteEnvPath).$PID.retire.tmp"
  [IO.File]::WriteAllLines($temporary, $lines, [Text.UTF8Encoding]::new($false))
  Set-RestrictedRuntimeFileAcl $temporary
  [IO.File]::Move($temporary, $script:MerchRouteEnvPath, $true)
  Set-RestrictedRuntimeFileAcl $script:MerchRouteEnvPath
  $readback = Get-DotEnvMap $script:MerchRouteEnvPath
  if (-not [string]::Equals([string]$readback.MERCHROUTE_DATA_ROOT, $script:TargetPath, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$readback.MERCHROUTE_LEGACY_DATA_ROOT, $script:LegacyPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'merchroute.env 兼容根写入读回失败'
  }
  Write-JsonAtomic $script:CompatibilityRequiredMarkerPath ([ordered]@{
    schemaVersion = 1
    required = $true
    legacyRoot = $script:LegacyPath
    canonicalRoot = $script:TargetPath
    createdAt = [DateTimeOffset]::Now.ToString('o')
  })
}

function Set-MerchRouteStartupShortcut {
  param([Parameter(Mandatory)][string]$RecoveryPoint)
  $backup = Join-Path $RecoveryPoint 'startup-scripts\merchroute-startup.lnk.original'
  if (-not [IO.File]::Exists($backup)) { throw '未找到 MerchRoute Startup 快捷方式备份' }
  $shell = New-Object -ComObject WScript.Shell
  $existing = $shell.CreateShortcut($script:MerchRouteShortcutPath)
  $temporary = "$($script:MerchRouteShortcutPath).$PID.retire.tmp.lnk"
  $shortcut = $shell.CreateShortcut($temporary)
  $shortcut.TargetPath = Join-Path $script:ProjectRoot 'scripts\start-windows.cmd'
  $shortcut.WorkingDirectory = Join-Path $script:ProjectRoot 'scripts'
  $shortcut.Arguments = ''
  $shortcut.Description = $existing.Description
  $shortcut.IconLocation = $existing.IconLocation
  $shortcut.WindowStyle = $existing.WindowStyle
  $shortcut.Save()
  [IO.File]::Move($temporary, $script:MerchRouteShortcutPath, $true)
  $readback = $shell.CreateShortcut($script:MerchRouteShortcutPath)
  if (-not [string]::Equals($readback.TargetPath, (Join-Path $script:ProjectRoot 'scripts\start-windows.cmd'), [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($readback.WorkingDirectory, (Join-Path $script:ProjectRoot 'scripts'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Startup 快捷方式更新读回失败'
  }
}

function Get-MerchRouteStartupLauncher {
  if (-not [IO.File]::Exists($script:MerchRouteShortcutPath)) { throw 'MerchRoute Startup 快捷方式不存在' }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($script:MerchRouteShortcutPath)
  $launcher = Get-NormalizedLiteralPath $shortcut.TargetPath
  if ($launcher -notmatch '(?i)\\scripts\\start-windows\.cmd$' -or
      $launcher.StartsWith($script:LegacyPath, [StringComparison]::OrdinalIgnoreCase) -or
      -not [IO.File]::Exists($launcher)) {
    throw "当前 MerchRoute Startup 入口不安全：$launcher"
  }
  return $launcher
}

function Restore-RuntimeConfiguration {
  param([Parameter(Mandatory)][string]$RecoveryPoint)
  $environmentBackup = Join-Path $RecoveryPoint 'external-config\merchroute.env.original'
  $shortcutBackup = Join-Path $RecoveryPoint 'startup-scripts\merchroute-startup.lnk.original'
  if (-not [IO.File]::Exists($environmentBackup) -or -not [IO.File]::Exists($shortcutBackup)) {
    throw '回滚配置备份不完整'
  }
  [IO.File]::Copy($environmentBackup, $script:MerchRouteEnvPath, $true)
  [IO.File]::Copy($shortcutBackup, $script:MerchRouteShortcutPath, $true)
  $markerBackup = Join-Path $RecoveryPoint 'external-config\legacy-root-retirement-required-v1.json.original'
  if ([IO.File]::Exists($markerBackup)) {
    [IO.File]::Copy($markerBackup, $script:CompatibilityRequiredMarkerPath, $true)
  } elseif ([IO.File]::Exists($script:CompatibilityRequiredMarkerPath)) {
    [IO.File]::Delete($script:CompatibilityRequiredMarkerPath)
  }
}

function Find-LegacyRootReferences {
  param($Value, [string]$Location = '$')
  $hits = [Collections.Generic.List[string]]::new()
  function Visit($Current, [string]$CurrentLocation) {
    if ($null -eq $Current) { return }
    if ($Current -is [string]) {
      if ($Current -match '(?i)G:[\\/]01_n8n-global(?=$|[\\/]|[^A-Za-z0-9_.-])') { $hits.Add($CurrentLocation) }
      return
    }
    if ($Current -is [Collections.IDictionary]) {
      foreach ($key in $Current.Keys) { Visit $Current[$key] "$CurrentLocation.$key" }
      return
    }
    if ($Current -is [Collections.IEnumerable] -and $Current -isnot [pscustomobject]) {
      $index = 0
      foreach ($item in $Current) { Visit $item "$CurrentLocation[$index]"; $index += 1 }
      return
    }
    foreach ($property in $Current.PSObject.Properties) { Visit $property.Value "$CurrentLocation.$($property.Name)" }
  }
  Visit $Value $Location
  return @($hits)
}

function Invoke-WorkflowExport {
  param([Parameter(Mandatory)][string]$RecoveryPoint, [Parameter(Mandatory)][string]$Label)
  $root = Assert-RecoveryChild $RecoveryPoint (Join-Path $RecoveryPoint "n8n-workflows\$Label")
  $current = Join-Path $root 'current'
  $published = Join-Path $root 'published'
  if ([IO.Directory]::Exists($root)) { throw "拒绝覆盖工作流备份：$root" }
  [IO.Directory]::CreateDirectory($current) | Out-Null
  [IO.Directory]::CreateDirectory($published) | Out-Null
  $n8n = Join-Path $env:APPDATA 'npm\n8n.cmd'
  if (-not [IO.File]::Exists($n8n)) { throw "未找到全局 n8n.cmd：$n8n" }
  $environment = Get-DotEnvMap $script:N8nEnvPath
  $previous = @{}
  try {
    foreach ($entry in $environment.GetEnumerator()) {
      if ($entry.Key -match '^(?:DB_|N8N_DB_)') {
        $previous[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
      }
    }
    $previous['N8N_USER_FOLDER'] = $env:N8N_USER_FOLDER
    $env:N8N_USER_FOLDER = $script:N8nUserDataPath
    & $n8n export:workflow --backup "--output=$current" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'n8n current workflow export failed' }
    & $n8n export:workflow --all --published --pretty --separate "--output=$published" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'n8n published workflow export failed' }
  } finally {
    foreach ($entry in $previous.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
  }
  $currentWorkflows = @(Get-ChildItem -LiteralPath $current -Filter '*.json' -File | ForEach-Object {
    Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json -Depth 100
  })
  $publishedWorkflows = @(Get-ChildItem -LiteralPath $published -Filter '*.json' -File | ForEach-Object {
    Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json -Depth 100
  })
  if ($currentWorkflows.Count -eq 0 -or $publishedWorkflows.Count -eq 0) { throw 'n8n 工作流导出为空' }
  $active = @($currentWorkflows | Where-Object { $_.active -eq $true } | ForEach-Object {
    [pscustomobject]@{ id = $_.id; name = $_.name; active = [bool]$_.active; versionId = $_.versionId; activeVersionId = $_.activeVersionId }
  } | Sort-Object id)
  $publishedMap = @{}
  foreach ($workflow in $publishedWorkflows) { $publishedMap[[string]$workflow.id] = $workflow }
  foreach ($workflow in $active) {
    if (-not $publishedMap.ContainsKey([string]$workflow.id)) { throw "活动工作流缺少 published 导出：$($workflow.id)" }
    if (-not [string]::Equals([string]$publishedMap[[string]$workflow.id].versionId, [string]$workflow.activeVersionId, [StringComparison]::OrdinalIgnoreCase)) {
      throw "published versionId 与 activeVersionId 不一致：$($workflow.id)"
    }
    $currentWorkflow = $currentWorkflows | Where-Object { [string]$_.id -eq [string]$workflow.id } | Select-Object -First 1
    $currentHits = @(Find-LegacyRootReferences $currentWorkflow.nodes "current:$($workflow.id).nodes")
    $publishedHits = @(Find-LegacyRootReferences $publishedMap[[string]$workflow.id].nodes "published:$($workflow.id).nodes")
    if ($currentHits.Count -gt 0 -or $publishedHits.Count -gt 0) {
      throw "活动工作流节点仍含旧根：$($workflow.id) current=$($currentHits.Count) published=$($publishedHits.Count)"
    }
  }
  $manifest = [ordered]@{
    generatedAt = [DateTimeOffset]::Now.ToString('o')
    activeWorkflows = $active
    currentCount = $currentWorkflows.Count
    publishedCount = $publishedWorkflows.Count
    activeNodeLegacyReferenceCount = 0
    files = @(Get-ChildItem -LiteralPath $root -Filter '*.json' -File -Recurse | ForEach-Object {
      [pscustomobject]@{ relativePath = [IO.Path]::GetRelativePath($root, $_.FullName); sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash }
    } | Sort-Object relativePath)
  }
  Write-JsonAtomic (Join-Path $root 'manifest.json') $manifest
  return $manifest
}

function Backup-AclEvidence {
  param([Parameter(Mandatory)][string]$RecoveryPoint)
  $metadata = Join-Path $RecoveryPoint 'metadata'
  [IO.Directory]::CreateDirectory($metadata) | Out-Null
  $legacyOutput = & fsutil.exe reparsepoint query $script:LegacyPath 2>&1
  [IO.File]::WriteAllLines((Join-Path $metadata 'junction-fsutil.txt'), [string[]]$legacyOutput, [Text.UTF8Encoding]::new($false))
  if ($LASTEXITCODE -ne 0) { throw 'fsutil reparsepoint query 失败' }
  $junctionId = & fsutil.exe file queryfileid $script:LegacyPath 2>&1
  [IO.File]::WriteAllLines((Join-Path $metadata 'junction-fileid-fsutil.txt'), [string[]]$junctionId, [Text.UTF8Encoding]::new($false))
  if ($LASTEXITCODE -ne 0) { throw 'fsutil Junction File ID 查询失败' }
  $targetId = & fsutil.exe file queryfileid $script:TargetPath 2>&1
  [IO.File]::WriteAllLines((Join-Path $metadata 'target-fileid-fsutil.txt'), [string[]]$targetId, [Text.UTF8Encoding]::new($false))
  if ($LASTEXITCODE -ne 0) { throw 'fsutil Target File ID 查询失败' }
  & icacls.exe $script:LegacyPath /L /save (Join-Path $metadata 'junction-acl.icacls') /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Junction ACL 备份失败' }
  & icacls.exe $script:TargetPath /save (Join-Path $metadata 'target-acl.icacls') /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Target ACL 备份失败' }
}

function Invoke-BackupSet {
  param([Parameter(Mandatory)][string]$RecoveryPoint, [Parameter(Mandatory)][string]$Label, [switch]$Final)
  $results = [ordered]@{}
  $results.MerchRouteData = Invoke-RobocopyMirror $script:TargetPath (Join-Path $RecoveryPoint 'merchroute-data') $RecoveryPoint "$Label-merchroute-data" -Final:$Final
  $results.N8nUserData = Invoke-RobocopyMirror $script:N8nUserDataPath (Join-Path $RecoveryPoint 'n8n-user-data') $RecoveryPoint "$Label-n8n-user-data" -Final:$Final
  $results.MerchRouteAppData = Invoke-RobocopyMirror $script:MerchRouteAppDataPath (Join-Path $RecoveryPoint 'merchroute-appdata') $RecoveryPoint "$Label-merchroute-appdata" -Final:$Final
  $results.MerchRouteDatabase = Invoke-PgDumpValidated (Get-MerchRoutePgConnection) (Join-Path $RecoveryPoint "database\merchroute-$Label.dump")
  $results.N8nDatabase = Invoke-PgDumpValidated (Get-N8nPgConnection) (Join-Path $RecoveryPoint "database\n8n-$Label.dump")
  $results.Workflows = Invoke-WorkflowExport $RecoveryPoint $Label
  return $results
}

function New-PrepareState {
  param([Parameter(Mandatory)][string]$RecoveryPoint, $Identity, $Inventory, $BackupResults, $ConfigFiles, [Parameter(Mandatory)]$Release)
  [ordered]@{
    schemaVersion = 2
    phase = 'PREPARED'
    createdAt = [DateTimeOffset]::Now.ToString('o')
    legacyPath = $script:LegacyPath
    targetPath = $script:TargetPath
    projectRoot = $script:ProjectRoot
    branch = $Release.Branch
    head = $Release.Head
    junctionBefore = $Identity.Junction
    targetBefore = $Identity.Target
    targetInventoryBefore = Get-InventorySummary $Inventory
    configFiles = $ConfigFiles
    precopy = $BackupResults
    precopyCapacity = $null
    compatibilityConfiguredAt = $null
    compatibilityDeployedAt = $null
    compatibilityDeployment = $null
    maintenanceToken = $null
    runtimeProcessesBefore = $null
    finalBackup = $null
    finalBackupAttempts = @()
    staleE001Cancellation = $null
    cutoverFailures = @()
    releaseRebinds = @()
    quarantinePath = $null
    quarantinedAt = $null
    finalNotBefore = $null
    targetInventoryAtQuarantine = $null
    rolledBackAt = $null
    rollbackReason = $null
    finalizedAt = $null
    junctionRemovedAt = $null
    targetInventoryAtFinalization = $null
    recreatedJunction = $null
  }
}

function Invoke-Prepare {
  $release = Assert-TaskWorktreeReleaseReady
  [void](Get-HealthGate)
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $root = if ($RecoveryPoint) { Assert-RecoveryPointPath $RecoveryPoint } else { Join-Path $script:BackupBase $timestamp }
  $identity = Assert-ExactLegacyJunction
  $inventory = Get-SafeTreeInventory $script:TargetPath
  $n8nInventory = Get-SafeTreeInventory $script:N8nUserDataPath
  $appDataInventory = Get-SafeTreeInventory $script:MerchRouteAppDataPath
  $capacity = Assert-BackupCapacity ($inventory.TotalBytes + $n8nInventory.TotalBytes + $appDataInventory.TotalBytes)
  $root = New-RestrictedRecoveryPoint $root
  Backup-AclEvidence $root
  $originalMerchRouteLauncher = Get-MerchRouteStartupLauncher
  $originalMerchRoutePowerShellLauncher = [IO.Path]::ChangeExtension($originalMerchRouteLauncher, '.ps1')
  $configFiles = @(
    Copy-ProtectedFile $script:MerchRouteEnvPath (Join-Path $root 'external-config\merchroute.env.original') $root
    Copy-ProtectedFile $script:N8nEnvPath (Join-Path $root 'external-config\n8n.env.original') $root
    Copy-ProtectedFile $script:N8nLauncherPath (Join-Path $root 'startup-scripts\启动n8n.bat.original') $root
    Copy-ProtectedFile $script:MerchRouteShortcutPath (Join-Path $root 'startup-scripts\merchroute-startup.lnk.original') $root
    Copy-ProtectedFile $script:N8nShortcutPath (Join-Path $root 'startup-scripts\n8n-startup.lnk.original') $root
    Copy-ProtectedFile $originalMerchRouteLauncher (Join-Path $root 'startup-scripts\merchroute-start-windows.cmd.original') $root
    Copy-ProtectedFile $originalMerchRoutePowerShellLauncher (Join-Path $root 'startup-scripts\merchroute-start-windows.ps1.original') $root
  )
  if ([IO.File]::Exists($script:CompatibilityRequiredMarkerPath)) {
    $configFiles += Copy-ProtectedFile $script:CompatibilityRequiredMarkerPath `
      (Join-Path $root 'external-config\legacy-root-retirement-required-v1.json.original') $root
  }
  $backup = Invoke-BackupSet $root 'precopy'
  $releaseAfterBackup = Assert-TaskWorktreeReleaseReady
  if ($releaseAfterBackup.Head -ne $release.Head -or $releaseAfterBackup.Branch -ne $release.Branch) {
    throw '预复制期间任务分支或 HEAD 发生变化，拒绝安装兼容配置'
  }
  $state = New-PrepareState $root $identity $inventory $backup $configFiles $release
  $state.precopyCapacity = $capacity
  Write-State $root $state
  # The original environment and startup shortcut are now recoverable. Only at
  # this point may the compatibility configuration be installed. The running
  # processes are not restarted by Prepare; deploy and verify the task worktree
  # before invoking Cutover.
  try {
    Set-RuntimeCompatibilityEnvironment $root
    Set-MerchRouteStartupShortcut $root
    $state.compatibilityConfiguredAt = [DateTimeOffset]::Now.ToString('o')
    Write-State $root $state
  } catch {
    Restore-RuntimeConfiguration $root
    throw
  }
  Assert-RestrictedAcl $root
  [pscustomobject]@{ ok = $true; action = 'Prepare'; recoveryPoint = $root; phase = $state.phase; state = (Join-Path $root $script:StateFileName) }
}

function Move-LegacyJunctionToQuarantine {
  param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][string]$QuarantinePath)
  $identity = Assert-ExactLegacyJunction
  if (-not (Test-IdentityEqual $identity.Junction $State.junctionBefore) -or -not (Test-IdentityEqual $identity.Target $State.targetBefore)) {
    throw '切换前 Junction/Target File ID 与恢复点不一致'
  }
  $quarantine = Assert-QuarantinePath $QuarantinePath
  if ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($quarantine)) { throw "隔离名称已存在：$quarantine" }
  [MerchRoute.JunctionRetirement.NativeFs]::MoveJunctionWriteThrough($script:LegacyPath, $quarantine)
  if ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($script:LegacyPath)) { throw 'Junction 改名后旧名称仍存在' }
  [void](Assert-QuarantinedJunction $quarantine $State.junctionBefore $State.targetBefore)
  return $quarantine
}

function Restore-QuarantinedJunctionName {
  param([Parameter(Mandatory)]$State)
  $quarantine = Assert-QuarantinePath ([string]$State.quarantinePath)
  if ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($script:LegacyPath)) { throw '旧 Junction 名称已被占用，拒绝回滚覆盖' }
  [void](Assert-QuarantinedJunction $quarantine $State.junctionBefore $State.targetBefore)
  [MerchRoute.JunctionRetirement.NativeFs]::MoveJunctionWriteThrough($quarantine, $script:LegacyPath)
  [void](Assert-ExactLegacyJunction)
}

function New-LegacyJunctionAfterFinalization {
  param([Parameter(Mandatory)]$State)
  if ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($script:LegacyPath)) {
    throw '旧 Junction 名称已被占用，拒绝创建'
  }
  if ($State.quarantinePath -and [MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow([string]$State.quarantinePath)) {
    throw '隔离对象仍存在，拒绝创建第二个 Junction'
  }
  $target = Get-TargetEvidence $script:TargetPath
  if (-not (Test-IdentityEqual $target $State.targetBefore)) { throw '真实目标 File ID 已变化，拒绝重建 Junction' }
  New-Item -ItemType Junction -Path $script:LegacyPath -Target $script:TargetPath | Out-Null
  [MerchRoute.JunctionRetirement.NativeFs]::SetReparsePointSddl($script:LegacyPath, [string]$State.junctionBefore.Sddl)
  $created = Assert-ExactLegacyJunction
  if (-not [string]::Equals([string]$created.Junction.Sddl, [string]$State.junctionBefore.Sddl, [StringComparison]::Ordinal)) {
    throw '重建 Junction 的 SDDL 与原始证据不一致'
  }
  if (-not (Test-IdentityEqual $created.Target $State.targetBefore)) { throw '重建 Junction 后目标身份不一致' }
  return $created.Junction
}

function Assert-CompletedFinalBackupForRecovery {
  param([Parameter(Mandatory)][string]$RecoveryPoint, [Parameter(Mandatory)]$State)
  Assert-RestrictedAcl $RecoveryPoint
  $configFiles = @($State.configFiles)
  if ($configFiles.Count -eq 0) { throw '恢复 Cutover 前缺少外部配置和启动脚本备份证据' }
  foreach ($configFile in $configFiles) {
    $configPath = Assert-RecoveryChild $RecoveryPoint ([string]$configFile.Destination)
    if (-not [IO.File]::Exists($configPath) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $configPath).Hash -ne [string]$configFile.Sha256) {
      throw "恢复配置备份不存在或哈希变化：$configPath"
    }
    Assert-RestrictedAcl $configPath -AllowInherited
  }
  $attempts = @($State.finalBackupAttempts)
  if ($attempts.Count -eq 0 -or $attempts[-1].status -ne 'COMPLETED' -or -not $State.finalBackup) {
    throw '恢复 Cutover 前缺少已完成的最终备份证据'
  }
  $finalLabel = [string]$attempts[-1].label
  foreach ($propertyName in @('MerchRouteData', 'N8nUserData', 'MerchRouteAppData')) {
    $evidence = $State.finalBackup.$propertyName
    if (-not $evidence.Mirror -or [long]$evidence.Mirror.FileCount -le 0 -or [long]$evidence.Mirror.TotalBytes -le 0) {
      throw "最终备份镜像证据不完整：$propertyName"
    }
    $samples = @($evidence.RestoreRehearsal.Files)
    if ($samples.Count -eq 0) { throw "最终备份恢复抽查为空：$propertyName" }
    $sampleLabel = [string]$evidence.RestoreRehearsal.Label
    if (-not $sampleLabel.StartsWith("$finalLabel-", [StringComparison]::Ordinal)) {
      throw "恢复抽查不属于最后一次已完成备份：$propertyName"
    }
    foreach ($sample in $samples) {
      $samplePath = Assert-RecoveryChild $RecoveryPoint (Join-Path $RecoveryPoint "restore-rehearsal\$sampleLabel\$($sample.RelativePath)")
      if (-not [IO.File]::Exists($samplePath)) { throw "恢复抽查文件不存在：$samplePath" }
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $samplePath).Hash -ne [string]$sample.Sha256) {
        throw "恢复抽查文件哈希变化：$samplePath"
      }
    }
  }
  foreach ($propertyName in @('MerchRouteDatabase', 'N8nDatabase')) {
    $evidence = $State.finalBackup.$propertyName
    $dumpPath = Assert-RecoveryChild $RecoveryPoint ([string]$evidence.Path)
    if ([IO.Path]::GetFileName($dumpPath).IndexOf($finalLabel, [StringComparison]::Ordinal) -lt 0 -or
        -not [IO.File]::Exists($dumpPath) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $dumpPath).Hash -ne [string]$evidence.Sha256) {
      throw "最终数据库备份不存在或哈希变化：$propertyName"
    }
    if (-not [IO.File]::Exists("$dumpPath.toc.txt")) { throw "最终数据库 TOC 不存在：$propertyName" }
  }
  $workflows = $State.finalBackup.Workflows
  $workflowManifest = Assert-RecoveryChild $RecoveryPoint (Join-Path $RecoveryPoint "n8n-workflows\$finalLabel\manifest.json")
  if (-not [IO.File]::Exists($workflowManifest) -or [int]$workflows.currentCount -le 0 -or
      [int]$workflows.publishedCount -le 0 -or [int]$workflows.activeNodeLegacyReferenceCount -ne 0 -or
      @($workflows.files).Count -ne ([int]$workflows.currentCount + [int]$workflows.publishedCount)) {
    throw '最终 n8n 工作流备份或活动旧根引用证据不完整'
  }
  foreach ($workflowFile in @($workflows.files)) {
    $workflowPath = Assert-RecoveryChild $RecoveryPoint (Join-Path $RecoveryPoint "n8n-workflows\$finalLabel\$($workflowFile.relativePath)")
    if (-not [IO.File]::Exists($workflowPath) -or
        (Get-FileHash -Algorithm SHA256 -LiteralPath $workflowPath).Hash -ne [string]$workflowFile.sha256) {
      throw "最终 n8n 工作流备份不存在或哈希变化：$($workflowFile.relativePath)"
    }
  }
  $cancellation = $State.staleE001Cancellation
  $cancellationValid = $cancellation -and [bool]$cancellation.exactSet -and
    ((-not [bool]$cancellation.alreadyCanceled -and [int]$cancellation.updatedCount -eq 72 -and [int]$cancellation.matchedCount -eq 72) -or
     ([bool]$cancellation.alreadyCanceled -and [int]$cancellation.matchedCount -eq 72))
  if (-not $cancellationValid) { throw '72 条 E001 stale execution 的精确取消证据不完整' }
  return [pscustomobject]@{
    Label = $finalLabel
    RestoreSampleCount = @('MerchRouteData', 'N8nUserData', 'MerchRouteAppData') |
      ForEach-Object { @($State.finalBackup.$_.RestoreRehearsal.Files).Count } |
      Measure-Object -Sum | Select-Object -ExpandProperty Sum
    WorkflowCurrentCount = [int]$workflows.currentCount
    WorkflowPublishedCount = [int]$workflows.publishedCount
  }
}

function Assert-CutoverRecoveryReleaseDiff {
  param([Parameter(Mandatory)]$State, [Parameter(Mandatory)]$Release)
  if (-not [string]::Equals([string]$State.projectRoot, $script:ProjectRoot, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$State.branch, [string]$Release.Branch, [StringComparison]::Ordinal) -or
      -not [string]::Equals([string]$State.legacyPath, $script:LegacyPath, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([string]$State.targetPath, $script:TargetPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw '恢复点的项目、分支或固定 Junction 路径与当前任务不一致'
  }
  $fromHead = [string]$State.head
  $toHead = [string]$Release.Head
  if ($fromHead -notmatch '^[a-f0-9]{40}$' -or $toHead -notmatch '^[a-f0-9]{40}$' -or $fromHead -eq $toHead) {
    throw '恢复 Cutover 需要从失败恢复点 HEAD 前进到一个新的干净 HEAD'
  }
  & git -C $script:ProjectRoot cat-file -e "$fromHead`^{commit}" 2>$null
  if ($LASTEXITCODE -ne 0) { throw "恢复点 HEAD 无法在本机仓库解析：$fromHead" }
  & git -C $script:ProjectRoot merge-base --is-ancestor $fromHead $toHead
  if ($LASTEXITCODE -ne 0) { throw '恢复修复 HEAD 不是失败恢复点 HEAD 的后代' }
  $changedFiles = @(& git -C $script:ProjectRoot diff --name-only "$fromHead..$toHead" --)
  if ($LASTEXITCODE -ne 0 -or $changedFiles.Count -eq 0) { throw '无法读取恢复修复的文件差异' }
  $allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  [void]$allowed.Add('scripts/retire-n8n-global-junction.ps1')
  [void]$allowed.Add('scripts/test-retire-n8n-global-junction-safety.ps1')
  $unexpected = @($changedFiles | Where-Object { -not $allowed.Contains([string]$_) })
  if ($unexpected.Count -gt 0) {
    throw "恢复修复包含应用、配置或非退役测试文件：$($unexpected -join ', ')"
  }
  return [pscustomobject]@{ FromHead = $fromHead; ToHead = $toHead; ChangedFiles = $changedFiles }
}

function Invoke-RecoverCutover {
  if (-not $RecoveryPoint) { throw 'RecoverCutover 必须提供 RecoveryPoint' }
  $root = Assert-RecoveryPointPath $RecoveryPoint -MustExist
  $state = Read-State $root
  if ($state.phase -ne 'ROLLED_BACK') { throw "RecoverCutover 仅允许 ROLLED_BACK，当前为 $($state.phase)" }
  $failures = @($state.cutoverFailures)
  if ($failures.Count -eq 0 -or $failures[-1].phase -ne 'QUARANTINED' -or
      [string]$failures[-1].error -notmatch "property 'Port' cannot be found") {
    throw '恢复点不是本次已知 n8n 空端口数组启动失败'
  }
  $release = Assert-TaskWorktreeReleaseReady
  $releaseDiff = Assert-CutoverRecoveryReleaseDiff $state $release
  $backupEvidence = Assert-CompletedFinalBackupForRecovery $root $state
  $identity = Assert-ExactLegacyJunction
  if (-not (Test-IdentityEqual $identity.Junction $state.junctionBefore) -or
      -not (Test-IdentityEqual $identity.Target $state.targetBefore)) {
    throw 'RecoverCutover 前 Junction/Target File ID 与恢复点不一致'
  }
  if ($state.quarantinePath) {
    $priorQuarantinePath = Assert-QuarantinePath ([string]$state.quarantinePath)
    if ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($priorQuarantinePath)) {
      throw 'RecoverCutover 前隔离对象仍存在'
    }
  } else {
    $priorQuarantinePath = $null
  }
  Enter-Maintenance $root
  $state.maintenanceToken = $script:MaintenanceToken
  if ($state.PSObject.Properties.Name -notcontains 'releaseRebinds') {
    Add-Member -InputObject $state -NotePropertyName releaseRebinds -NotePropertyValue @()
  }
  $record = [ordered]@{
    fromHead = $releaseDiff.FromHead
    toHead = $releaseDiff.ToHead
    startedAt = [DateTimeOffset]::Now.ToString('o')
    completedAt = $null
    status = 'STARTED'
    reason = 'Recover verified QUARANTINED startup failure after completed final backup and exact E001 cancellation.'
    changedFiles = @($releaseDiff.ChangedFiles)
    priorQuarantinePath = $priorQuarantinePath
    retainedFinalBackupLabel = $backupEvidence.Label
    error = $null
  }
  try {
    Wait-OperationalDrain
    Set-RuntimeCompatibilityEnvironment $root
    Set-MerchRouteStartupShortcut $root
    [void](Start-NewRuntime $root)
    [void](Get-LegacyCompatibilityReadiness)
    $runtime = Assert-LiveRuntimeMatchesRelease $release
    $record.completedAt = [DateTimeOffset]::Now.ToString('o')
    $record.status = 'COMPLETED'
    $state.releaseRebinds = @(@($state.releaseRebinds) + $record)
    $state.head = $release.Head
    $state.phase = 'COMPATIBILITY_DEPLOYED'
    $state.compatibilityConfiguredAt = [DateTimeOffset]::Now.ToString('o')
    $state.compatibilityDeployedAt = [DateTimeOffset]::Now.ToString('o')
    $state.compatibilityDeployment = $runtime
    $state.quarantinePath = $null
    $state.quarantinedAt = $null
    $state.finalNotBefore = $null
    $state.targetInventoryAtQuarantine = $null
    $state.rolledBackAt = $null
    $state.rollbackReason = $null
    Write-State $root $state
    return [pscustomobject]@{
      ok = $true
      action = 'RecoverCutover'
      recoveryPoint = $root
      phase = $state.phase
      fromHead = $releaseDiff.FromHead
      toHead = $releaseDiff.ToHead
      retainedFinalBackupLabel = $backupEvidence.Label
      maintenanceRetained = $true
    }
  } catch {
    $failure = $_.Exception.Message
    $record.completedAt = [DateTimeOffset]::Now.ToString('o')
    $record.status = 'FAILED'
    $record.error = $failure
    $state.releaseRebinds = @(@($state.releaseRebinds) + $record)
    $state.rollbackReason = "RecoverCutover failed: $failure"
    Write-State $root $state
    try {
      [void](Stop-VerifiedRuntime -AllowAlreadyStopped)
      [void](Stop-VerifiedN8nLaunchersWithoutListeners)
      Restore-RuntimeConfiguration $root
      [void](Start-RestoredRuntime $root)
      Exit-Maintenance $root
    } catch {
      throw "RecoverCutover 失败且运行服务恢复未完成：$($_.Exception.Message)"
    }
    throw "RecoverCutover 失败，已恢复原运行入口：$failure"
  }
}

function Invoke-DeployCompatibility {
  if (-not $RecoveryPoint) { throw 'DeployCompatibility 必须提供 Prepare 生成的 RecoveryPoint' }
  $root = Assert-RecoveryPointPath $RecoveryPoint -MustExist
  $state = Read-State $root
  if ($state.phase -notin @('PREPARED', 'COMPATIBILITY_DEPLOYED')) {
    throw "DeployCompatibility 需要 PREPARED，当前为 $($state.phase)"
  }
  $release = Assert-StateMatchesRelease $state
  [void](Assert-ExactLegacyJunction)
  [void](Get-HealthGate)
  if ($state.phase -eq 'COMPATIBILITY_DEPLOYED') {
    [void](Get-LegacyCompatibilityReadiness)
    [void](Assert-LiveRuntimeMatchesRelease $release)
    return [pscustomobject]@{ ok = $true; action = 'DeployCompatibility'; recoveryPoint = $root; phase = $state.phase; alreadyDeployed = $true }
  }
  try {
    # A process crash after the new server starts but before state persistence is
    # recovered by proving the exact clean release and readiness in place.
    [void](Get-LegacyCompatibilityReadiness)
    $runtime = Assert-LiveRuntimeMatchesRelease $release
    $state.phase = 'COMPATIBILITY_DEPLOYED'
    $state.compatibilityDeployedAt = [DateTimeOffset]::Now.ToString('o')
    $state.compatibilityDeployment = $runtime
    Write-State $root $state
    return [pscustomobject]@{ ok = $true; action = 'DeployCompatibility'; recoveryPoint = $root; phase = $state.phase; recovered = $true }
  } catch { }

  $runtimeStopped = $false
  try {
    Set-RuntimeCompatibilityEnvironment $root
    Set-MerchRouteStartupShortcut $root
    [void](Assert-ExpectedPortOwners (Get-ListeningPortOwners) -RequireAllPorts)
    [void](Stop-VerifiedMerchRoute)
    $runtimeStopped = $true
    [void](Start-NewRuntime $root)
    [void](Get-LegacyCompatibilityReadiness)
    $runtime = Assert-LiveRuntimeMatchesRelease $release
    $state.phase = 'COMPATIBILITY_DEPLOYED'
    $state.compatibilityDeployedAt = [DateTimeOffset]::Now.ToString('o')
    $state.compatibilityDeployment = $runtime
    Write-State $root $state
    return [pscustomobject]@{ ok = $true; action = 'DeployCompatibility'; recoveryPoint = $root; phase = $state.phase; runtime = $runtime }
  } catch {
    $failure = $_.Exception.Message
    if ($runtimeStopped) {
      try { [void](Stop-VerifiedMerchRoute) } catch { }
    }
    Restore-RuntimeConfiguration $root
    $state.phase = 'ROLLED_BACK'
    $state.rolledBackAt = [DateTimeOffset]::Now.ToString('o')
    $state.rollbackReason = "Compatibility deployment failed: $failure"
    Write-State $root $state
    try { [void](Start-RestoredRuntime $root) } catch { throw "兼容版本部署失败，且原运行版本恢复失败：$($_.Exception.Message)" }
    throw "兼容版本部署失败，已恢复原运行版本：$failure"
  }
}

function Invoke-Cutover {
  if (-not $RecoveryPoint) { throw 'Cutover 必须提供 Prepare 生成的 RecoveryPoint' }
  $root = Assert-RecoveryPointPath $RecoveryPoint -MustExist
  $state = Read-State $root
  if ($state.phase -ne 'COMPATIBILITY_DEPLOYED') { throw "Cutover 需要 COMPATIBILITY_DEPLOYED，当前为 $($state.phase)" }
  $release = Assert-StateMatchesRelease $state
  [void](Assert-ExactLegacyJunction)
  [void](Get-HealthGate)
  [void](Get-LegacyCompatibilityReadiness)
  [void](Assert-LiveRuntimeMatchesRelease $release)
  Enter-Maintenance $root
  $state.maintenanceToken = $script:MaintenanceToken
  Write-State $root $state
  $runtimeStopped = $false
  $attempt = $null
  try {
    Wait-OperationalDrain -AllowKnownE001StaleExecutions
    $state.runtimeProcessesBefore = Get-ListeningPortOwners
    [void](Stop-VerifiedRuntime)
    $runtimeStopped = $true
    Wait-OperationalDrain -AllowKnownE001StaleExecutions
    $finalLabel = "final-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    $attempt = [ordered]@{ label = $finalLabel; startedAt = [DateTimeOffset]::Now.ToString('o'); completedAt = $null; status = 'STARTED'; error = $null }
    $state.finalBackupAttempts = @(@($state.finalBackupAttempts) + $attempt)
    Write-State $root $state
    $state.finalBackup = Invoke-BackupSet $root $finalLabel -Final
    $attempt.completedAt = [DateTimeOffset]::Now.ToString('o')
    $attempt.status = 'COMPLETED'
    $state.finalBackupAttempts = @(@($state.finalBackupAttempts | Select-Object -SkipLast 1) + $attempt)
    Write-State $root $state
    $state.staleE001Cancellation = Cancel-KnownE001StaleExecutions
    Write-State $root $state
    Wait-OperationalDrain
    $beforeRename = Get-SafeTreeInventory $script:TargetPath
    $state.quarantinePath = Assert-QuarantinePath ("G:\01_n8n-global.__quarantine__$(Get-Date -Format 'yyyyMMdd-HHmmss')")
    $state.phase = 'QUARANTINE_RENAME_PENDING'
    Write-State $root $state
    [void](Move-LegacyJunctionToQuarantine $state ([string]$state.quarantinePath))
    $state.quarantinedAt = [DateTimeOffset]::Now.ToString('o')
    $state.finalNotBefore = [DateTimeOffset]::Parse($state.quarantinedAt).AddHours(168).ToString('o')
    $afterRename = Get-SafeTreeInventory $script:TargetPath
    if (-not (Test-IdentityEqual $beforeRename.Identity $afterRename.Identity) -or
        $beforeRename.FileCount -ne $afterRename.FileCount -or $beforeRename.TotalBytes -ne $afterRename.TotalBytes) {
      throw '隔离改名前后真实目标身份或计数变化'
    }
    $state.phase = 'QUARANTINED'
    $state.targetInventoryAtQuarantine = Get-InventorySummary $afterRename
    Write-State $root $state
    [void](Start-NewRuntime $root)
    [void](Get-LegacyCompatibilityReadiness)
    [void](Assert-LiveRuntimeMatchesRelease $release)
    Exit-Maintenance $root
    return [pscustomobject]@{ ok = $true; action = 'Cutover'; recoveryPoint = $root; quarantinePath = $state.quarantinePath; finalNotBefore = $state.finalNotBefore }
  } catch {
    $cutoverFailure = $_.Exception.Message
    if ($attempt -and $attempt.status -eq 'STARTED') {
      $attempt.completedAt = [DateTimeOffset]::Now.ToString('o')
      $attempt.status = 'FAILED'
      $attempt.error = $cutoverFailure
      $state.finalBackupAttempts = @(@($state.finalBackupAttempts | Select-Object -SkipLast 1) + $attempt)
    }
    $failureRecord = [ordered]@{ failedAt = [DateTimeOffset]::Now.ToString('o'); phase = [string]$state.phase; error = $cutoverFailure }
    $state.cutoverFailures = @(@($state.cutoverFailures) + $failureRecord)
    if ($state.quarantinePath -and [MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow([string]$state.quarantinePath)) {
      try {
        try { [void](Stop-VerifiedRuntime -AllowAlreadyStopped) } catch { }
        Restore-QuarantinedJunctionName $state
        Restore-RuntimeConfiguration $root
        $state.phase = 'ROLLED_BACK'
        $state.rolledBackAt = [DateTimeOffset]::Now.ToString('o')
        $state.rollbackReason = $cutoverFailure
        Write-State $root $state
        [void](Start-RestoredRuntime $root)
        Exit-Maintenance $root
      } catch {
        throw "切换失败且自动回滚未完成；隔离对象保持不动：$($_.Exception.Message)"
      }
    } elseif ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($script:LegacyPath)) {
      [void](Assert-ExactLegacyJunction)
      $state.phase = 'COMPATIBILITY_DEPLOYED'
      Write-State $root $state
      if ($runtimeStopped) { [void](Start-NewRuntime $root) }
      [void](Get-LegacyCompatibilityReadiness)
      [void](Assert-LiveRuntimeMatchesRelease $release)
      Exit-Maintenance $root
    } else {
      Write-State $root $state
      throw '切换失败后旧名称与已记录隔离对象均不存在；保持维护模式，必须人工核验'
    }
    throw
  }
}

function Get-OperationalStatus {
  param($State)
  $legacyExists = [MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($script:LegacyPath)
  $legacy = if ($legacyExists) {
    try {
      $value = Assert-ExactLegacyJunction
      [pscustomobject]@{ ok = $true; value = $value; error = $null }
    } catch { [pscustomobject]@{ ok = $false; value = $null; error = $_.Exception.Message } }
  } else {
    [pscustomobject]@{ ok = $true; value = $null; error = $null }
  }
  $quarantine = if ($State -and $State.quarantinePath -and [MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow([string]$State.quarantinePath)) {
    Assert-QuarantinedJunction ([string]$State.quarantinePath) $State.junctionBefore $State.targetBefore
  } else { $null }
  $health = try {
    $value = Get-HealthGate
    [pscustomobject]@{ ok = $true; value = $value; error = $null }
  } catch { [pscustomobject]@{ ok = $false; value = $null; error = $_.Exception.Message } }
  $compatibility = try {
    $value = Get-LegacyCompatibilityReadiness
    [pscustomobject]@{ ok = $true; value = $value; error = $null }
  } catch { [pscustomobject]@{ ok = $false; value = $null; error = $_.Exception.Message } }
  $n8nGate = try {
    $value = Get-N8nExecutionGate
    [pscustomobject]@{ ok = $true; value = $value; error = $null }
  } catch { [pscustomobject]@{ ok = $false; value = $null; error = $_.Exception.Message } }
  $databaseGate = try {
    $value = Get-MerchRouteDatabaseGate
    [pscustomobject]@{ ok = $true; value = $value; error = $null }
  } catch { [pscustomobject]@{ ok = $false; value = $null; error = $_.Exception.Message } }
  [pscustomobject]@{
    checkedAt = [DateTimeOffset]::Now.ToString('o')
    phase = if ($State) { $State.phase } else { 'UNTRACKED' }
    legacyPathExists = $legacyExists
    legacyJunction = $legacy
    quarantinePath = if ($State) { $State.quarantinePath } else { $null }
    quarantineVerified = $null -ne $quarantine
    target = Get-TargetEvidence $script:TargetPath
    ports = Get-ListeningPortOwners
    health = $health
    compatibility = $compatibility
    n8nExecutionGate = $n8nGate
    databaseGate = $databaseGate
  }
}

function Invoke-Status {
  $state = if ($RecoveryPoint) { Read-State (Assert-RecoveryPointPath $RecoveryPoint -MustExist) } else { $null }
  Get-OperationalStatus $state
}

function Invoke-Observe {
  if (-not $RecoveryPoint) { throw 'Observe 必须提供 RecoveryPoint' }
  $root = Assert-RecoveryPointPath $RecoveryPoint -MustExist
  $state = Read-State $root
  if ($state.phase -ne 'QUARANTINED') { throw '仅 QUARANTINED 阶段可记录观察' }
  $status = Get-OperationalStatus $state
  if ($status.legacyPathExists -or -not $status.quarantineVerified -or
      -not $status.health.ok -or -not $status.compatibility.ok -or
      -not $status.n8nExecutionGate.ok -or -not $status.databaseGate.ok) {
    throw '观察检查未通过，不记录为有效检查点'
  }
  $observation = [ordered]@{
    observedAt = [DateTimeOffset]::Now.ToString('o')
    coveredCapabilities = @($CoveredCapability | Sort-Object -Unique)
    status = $status
  }
  $line = ($observation | ConvertTo-Json -Depth 100 -Compress) + [Environment]::NewLine
  [IO.File]::AppendAllText((Join-Path $root $script:ObservationsFileName), $line, [Text.UTF8Encoding]::new($false))
  return $observation
}

function Get-ValidatedObservations {
  param([Parameter(Mandatory)][string]$RecoveryPoint, [Parameter(Mandatory)]$State)
  $path = Join-Path $RecoveryPoint $script:ObservationsFileName
  if (-not [IO.File]::Exists($path)) { throw '尚无观察记录' }
  $observations = @([IO.File]::ReadAllLines($path) | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json -Depth 100 })
  $quarantinedAt = [DateTimeOffset]::Parse([string]$State.quarantinedAt)
  $now = [DateTimeOffset]::Now
  if ($now -lt $quarantinedAt.AddHours(168)) { throw '隔离期不足 168 小时' }
  $checkpointWindows = @(
    [pscustomobject]@{ Label = '5 分钟'; Start = $quarantinedAt.AddMinutes(5); End = $quarantinedAt.AddMinutes(30) },
    [pscustomobject]@{ Label = '30 分钟'; Start = $quarantinedAt.AddMinutes(30); End = $quarantinedAt.AddHours(2) },
    [pscustomobject]@{ Label = '2 小时'; Start = $quarantinedAt.AddHours(2); End = $quarantinedAt.AddHours(24) },
    [pscustomobject]@{ Label = '24 小时'; Start = $quarantinedAt.AddHours(24); End = $quarantinedAt.AddHours(48) }
  )
  foreach ($window in $checkpointWindows) {
    if (-not ($observations | Where-Object {
      $time = [DateTimeOffset]::Parse($_.observedAt)
      $time -ge $window.Start -and $time -lt $window.End
    })) {
      throw "缺少隔离后 $($window.Label) 检查点"
    }
  }
  $orderedTimes = @($observations | ForEach-Object { [DateTimeOffset]::Parse($_.observedAt) } | Sort-Object)
  for ($index = 1; $index -lt $orderedTimes.Count; $index += 1) {
    if (($orderedTimes[$index] - $orderedTimes[$index - 1]).TotalHours -gt 36) {
      throw '每日观察记录存在超过 36 小时的空档，必须延长观察并补足连续覆盖'
    }
  }
  if ($orderedTimes.Count -eq 0 -or ($now - $orderedTimes[-1]).TotalHours -gt 36) {
    throw '最近一次有效观察已超过 36 小时'
  }
  $dailyDates = @($orderedTimes | ForEach-Object { $_.ToLocalTime().Date } | Sort-Object -Unique)
  if ($dailyDates.Count -lt 7) { throw '观察记录未覆盖至少 7 个自然日' }
  $covered = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($observation in $observations) { foreach ($capability in @($observation.coveredCapabilities)) { [void]$covered.Add([string]$capability) } }
  $missing = @($script:RequiredCoverage | Where-Object { -not $covered.Contains($_) })
  if ($missing.Count -gt 0) { throw "实际链路覆盖未完成：$($missing -join ', ')" }
  return $observations
}

function Remove-QuarantinedJunction {
  param([Parameter(Mandatory)]$State)
  $path = Assert-QuarantinePath ([string]$State.quarantinePath)
  [void](Assert-QuarantinedJunction $path $State.junctionBefore $State.targetBefore)
  $registry = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  if ([int]$registry.CurrentBuildNumber -lt 26100) { throw 'RemoveDirectory2W 要求 Windows 11 24H2 build 26100 或更高' }
  # This is the sole junction deletion call. Failure is terminal: there is no fallback.
  [MerchRoute.JunctionRetirement.NativeFs]::RemoveJunctionNoRedirects($path)
  $deadline = [DateTimeOffset]::Now.AddSeconds(30)
  while ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($path) -and [DateTimeOffset]::Now -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  if ([MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($path)) {
    throw 'RemoveDirectory2W 返回后隔离 Junction 仍存在；已停止且不尝试其他删除方式'
  }
}

function Invoke-Finalize {
  if (-not $RecoveryPoint) { throw 'Finalize 必须提供 RecoveryPoint' }
  $root = Assert-RecoveryPointPath $RecoveryPoint -MustExist
  $state = Read-State $root
  if ($state.phase -ne 'QUARANTINED') { throw "Finalize 需要 QUARANTINED，当前为 $($state.phase)" }
  $release = Assert-StateMatchesRelease $state
  [void](Get-ValidatedObservations $root $state)
  [void](Get-HealthGate)
  [void](Get-LegacyCompatibilityReadiness)
  [void](Assert-LiveRuntimeMatchesRelease $release)
  Enter-Maintenance $root
  $runtimeStopped = $false
  $junctionRemoved = $false
  try {
    Wait-OperationalDrain
    [void](Stop-VerifiedRuntime)
    $runtimeStopped = $true
    $before = Get-SafeTreeInventory $script:TargetPath
    [void](Assert-QuarantinedJunction ([string]$state.quarantinePath) $state.junctionBefore $state.targetBefore)
    Remove-QuarantinedJunction $state
    $junctionRemoved = $true
    $state.phase = 'FINALIZING_LINK_REMOVED'
    $state.junctionRemovedAt = [DateTimeOffset]::Now.ToString('o')
    Write-State $root $state
    $after = Get-SafeTreeInventory $script:TargetPath
    if (-not (Test-IdentityEqual $before.Identity $after.Identity) -or
        $before.FileCount -ne $after.FileCount -or $before.TotalBytes -ne $after.TotalBytes) {
      throw '最终删除前后真实目标 File ID、文件数或字节数不一致'
    }
    $state.phase = 'FINALIZED'
    $state.finalizedAt = [DateTimeOffset]::Now.ToString('o')
    $state.targetInventoryAtFinalization = Get-InventorySummary $after
    Write-State $root $state
    [void](Start-NewRuntime $root)
    [void](Get-LegacyCompatibilityReadiness)
    [void](Assert-LiveRuntimeMatchesRelease $release)
    Exit-Maintenance $root
    [pscustomobject]@{ ok = $true; action = 'Finalize'; recoveryPoint = $root; targetUnaffected = $true }
  } catch {
    # A failed RemoveDirectory2W is terminal for this attempt. There is no
    # fallback and no automatic second deletion call. Keep maintenance mode and
    # the stopped runtime so explicit Rollback can safely inspect whether the
    # quarantined junction survived or must be recreated.
    if ($junctionRemoved -and $state.phase -ne 'FINALIZING_LINK_REMOVED') {
      $state.phase = 'FINALIZING_LINK_REMOVED'
      $state.junctionRemovedAt = [DateTimeOffset]::Now.ToString('o')
      try { Write-State $root $state } catch { }
    }
    throw
  }
}

function Invoke-Rollback {
  if (-not $RecoveryPoint) { throw 'Rollback 必须提供 RecoveryPoint' }
  $root = Assert-RecoveryPointPath $RecoveryPoint -MustExist
  $state = Read-State $root
  if ($state.phase -notin @('PREPARED', 'COMPATIBILITY_DEPLOYED', 'QUARANTINE_RENAME_PENDING', 'QUARANTINED', 'FINALIZING_LINK_REMOVED', 'FINALIZED')) {
    throw "当前阶段不允许无数据回滚：$($state.phase)"
  }
  $rollbackFrom = [string]$state.phase
  if ($rollbackFrom -eq 'PREPARED') {
    [void](Assert-ExactLegacyJunction)
    $compatibilityIsLive = $false
    try {
      [void](Get-LegacyCompatibilityReadiness)
      $compatibilityIsLive = $true
    } catch { }
    if (-not $compatibilityIsLive) {
      Restore-RuntimeConfiguration $root
      $state.phase = 'ROLLED_BACK'
      $state.rolledBackAt = [DateTimeOffset]::Now.ToString('o')
      $state.rollbackReason = 'Explicit rollback from PREPARED before compatibility deployment'
      Write-State $root $state
      return [pscustomobject]@{ ok = $true; action = 'Rollback'; recoveryPoint = $root; databaseRestored = $false; runtimeRestarted = $false }
    }
  }
  Enter-Maintenance $root
  try {
    Wait-OperationalDrain -AllowKnownE001StaleExecutions
    [void](Stop-VerifiedRuntime -AllowAlreadyStopped)
    $legacyExists = [MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow($script:LegacyPath)
    $quarantineExists = $state.quarantinePath -and [MerchRoute.JunctionRetirement.NativeFs]::ExistsNoFollow([string]$state.quarantinePath)
    if ($rollbackFrom -in @('QUARANTINE_RENAME_PENDING', 'QUARANTINED')) {
      if ($quarantineExists -and -not $legacyExists) {
        Restore-QuarantinedJunctionName $state
      } elseif ($legacyExists -and -not $quarantineExists) {
        [void](Assert-ExactLegacyJunction)
      } elseif (-not $legacyExists -and -not $quarantineExists) {
        $state.recreatedJunction = New-LegacyJunctionAfterFinalization $state
      } else {
        throw '旧名称与隔离名称同时存在，拒绝猜测回滚对象'
      }
    } elseif ($rollbackFrom -in @('FINALIZING_LINK_REMOVED', 'FINALIZED')) {
      $state.recreatedJunction = New-LegacyJunctionAfterFinalization $state
    } else {
      [void](Assert-ExactLegacyJunction)
    }
    Restore-RuntimeConfiguration $root
    $state.phase = 'ROLLED_BACK'
    $state.rolledBackAt = [DateTimeOffset]::Now.ToString('o')
    $state.rollbackReason = "Explicit rollback from $rollbackFrom"
    Write-State $root $state
    [void](Start-RestoredRuntime $root)
    Exit-Maintenance $root
    [pscustomobject]@{ ok = $true; action = 'Rollback'; recoveryPoint = $root; databaseRestored = $false }
  } catch {
    throw
  }
}

if ($LibraryOnly) { return }

$result = switch ($Action) {
  'Prepare' { Invoke-Prepare }
  'DeployCompatibility' { Invoke-DeployCompatibility }
  'RecoverCutover' { Invoke-RecoverCutover }
  'Cutover' { Invoke-Cutover }
  'Status' { Invoke-Status }
  'Rollback' { Invoke-Rollback }
  'Observe' { Invoke-Observe }
  'Finalize' { Invoke-Finalize }
}
$result | ConvertTo-Json -Depth 100
