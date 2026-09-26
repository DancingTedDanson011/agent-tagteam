# CLI Organizer watchdog. Waits for the app process to end; if it ended without releasing its
# captured windows, restores every window still listed in the restore journal.
#
# Why PowerShell and not the app's own executable in Node mode: while an electron.exe child in
# Node mode was alive, the app's main process hung on quit (measured: 2 of 3 and 4 of 4 runs);
# with a PowerShell child it quit cleanly in 4 of 4 runs.
#
# The restore mirrors src/main/capture/restore.ts (restoreEntry). Keep the two in step.
param(
  [Parameter(Mandatory)] [int] $ParentPid,
  [string] $ParentStart = '',
  [Parameter(Mandatory)] [string] $Journal,
  [Parameter(Mandatory)] [string] $Log
)

$ErrorActionPreference = 'Stop'

function Write-Log([string] $line) {
  try { Add-Content -LiteralPath $Log -Value ("{0} {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $line) } catch { }
}

# Any unexpected error ends up in the log instead of vanishing with the hidden console.
trap {
  Write-Log "watchdog error: $($_.Exception.Message)"
  exit 1
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ClioRestore {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length, flags, showCmd; public POINT ptMinPosition, ptMaxPosition; public RECT rcNormalPosition;
  }

  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll")] static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);

  const int GWLP_HWNDPARENT = -8, GWL_STYLE = -16, GWL_EXSTYLE = -20;
  const uint FRAME_ONLY = 0x0002 | 0x0001 | 0x0004 | 0x0010 | 0x0020; // NOMOVE NOSIZE NOZORDER NOACTIVATE FRAMECHANGED

  public static string StartTime(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return null;
    try {
      long c, e, k, u;
      return GetProcessTimes(h, out c, out e, out k, out u) ? ((ulong)c).ToString() : null;
    } finally { CloseHandle(h); }
  }

  // Returns: restored | gone | mismatch | failed
  public static string Restore(long hwnd, uint pid, string startTime, string className, long style, long exStyle,
                               int flags, int showCmd, int minX, int minY, int maxX, int maxY,
                               int left, int top, int right, int bottom) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return "gone";
    uint actual; GetWindowThreadProcessId(h, out actual);
    if (actual != pid) return "mismatch";
    var b = new StringBuilder(256); GetClassName(h, b, 256);
    if (b.ToString() != className) return "mismatch";
    if (startTime != null && StartTime(pid) != startTime) return "mismatch";

    SetWindowLongPtr(h, GWLP_HWNDPARENT, IntPtr.Zero);
    SetWindowLongPtr(h, GWL_STYLE, new IntPtr(style));
    SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(exStyle));
    SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, FRAME_ONLY);
    var wp = new WINDOWPLACEMENT();
    wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
    wp.flags = flags;
    wp.showCmd = showCmd == 1 ? 4 : showCmd; // SW_SHOWNORMAL -> SW_SHOWNOACTIVATE
    wp.ptMinPosition = new POINT { X = minX, Y = minY };
    wp.ptMaxPosition = new POINT { X = maxX, Y = maxY };
    wp.rcNormalPosition = new RECT { Left = left, Top = top, Right = right, Bottom = bottom };
    return SetWindowPlacement(h, ref wp) ? "restored" : "failed";
  }
}
'@

# ---- wait for the app. With a known start time, a reused PID does not count as the app;
#      without one we can only wait on the PID (never restore while the app might still run). ----
$current = [ClioRestore]::StartTime([uint32]$ParentPid)
if ($current -ne $null -and (-not $ParentStart -or $current -eq $ParentStart)) {
  try {
    $proc = [System.Diagnostics.Process]::GetProcessById($ParentPid)
    Write-Log "watching pid $ParentPid"
    $proc.WaitForExit()
  } catch {
    # ended between the two calls
  }
}

# ---- restore whatever is still journaled ----
# The app deletes its (empty) journal on a clean exit; no file means nothing was left captured.
if (-not (Test-Path -LiteralPath $Journal)) {
  Write-Log 'app ended cleanly, nothing to restore'
  exit 0
}
$entries = @()
try {
  $parsed = Get-Content -LiteralPath $Journal -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($parsed.entries) { $entries = @($parsed.entries) }
} catch {
  Write-Log "journal unreadable: $($_.Exception.Message)"
  exit 1
}

if ($entries.Count -eq 0) {
  Write-Log 'app ended cleanly, nothing to restore'
  exit 0
}

$outcomes = @()
$done = @()
foreach ($e in $entries) {
  $p = $e.placement
  try {
    $outcome = [ClioRestore]::Restore([int64]$e.hwnd, [uint32]$e.pid, $e.startTime, $e.className, [int64]$e.style, [int64]$e.exStyle,
      [int]$p.flags, [int]$p.showCmd, [int]$p.ptMinPosition.x, [int]$p.ptMinPosition.y, [int]$p.ptMaxPosition.x, [int]$p.ptMaxPosition.y,
      [int]$p.rcNormalPosition.left, [int]$p.rcNormalPosition.top, [int]$p.rcNormalPosition.right, [int]$p.rcNormalPosition.bottom)
  } catch {
    $outcome = 'failed'
  }
  $outcomes += $outcome
  if ($outcome -ne 'failed') { $done += [string]$e.hwnd }
}

# Merge, never replace: re-read the journal now — a newly started app may have added entries while
# a hung window kept this restore busy — and remove only what was handled here. Failed entries stay
# journaled; the next app start retries them. Own temp name, so the app's writer never collides.
$current = @()
try {
  $now = Get-Content -LiteralPath $Journal -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($now.entries) { $current = @($now.entries) }
} catch { }
$remaining = @($current | Where-Object { $done -notcontains [string]$_.hwnd })
# Written without a BOM (Set-Content -Encoding UTF8 adds one in Windows PowerShell 5.1).
$tmp = "$Journal.watchdog.tmp"
$json = ConvertTo-Json -InputObject @{ version = 1; entries = @($remaining) } -Depth 6
[System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $tmp -Destination $Journal -Force
Write-Log ("app ended with {0} captured window(s): {1}" -f $entries.Count, ($outcomes -join ', '))
