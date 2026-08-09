# ============================================
# Zule AI — Focus Monitor Test Script
# ============================================
# Polls GetForegroundWindow every 50ms and logs any focus change.
# Use this to verify zule's overlay never steals focus.
#
# Usage: Right-click this file > "Run with PowerShell"
#   OR open PowerShell and run: .\scripts\focus-monitor.ps1
#
# Press Ctrl+C to stop.

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FocusMonitor {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ZULE FOCUS MONITOR - Testing Mode" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "This script monitors which window has OS focus." -ForegroundColor Yellow
Write-Host "If zule NEVER appears in this log while you click/type on it," -ForegroundColor Yellow
Write-Host "then the focus-steal fix is working." -ForegroundColor Yellow
Write-Host ""
Write-Host "Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host ""
Write-Host "Monitoring started at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Green
Write-Host "---" -ForegroundColor Gray

$last = [IntPtr]::Zero
$count = 0

while ($true) {
    $current = [FocusMonitor]::GetForegroundWindow()
    if ($current -ne $last) {
        $count++
        $sb = New-Object System.Text.StringBuilder 256
        [FocusMonitor]::GetWindowText($current, $sb, 256) | Out-Null
        $title = $sb.ToString()

        $procId = 0
        [FocusMonitor]::GetWindowThreadProcessId($current, [ref]$procId) | Out-Null

        $procName = ""
        try {
            $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
            $procName = $proc.ProcessName
        } catch {}

        # Highlight if zule/electron appears
        $color = "White"
        if ($title -match "zule|electron|overlay" -or $procName -match "zule|electron") {
            $color = "Red"
            Write-Host "!! FOCUS STOLEN !!" -ForegroundColor Red -NoNewline
            Write-Host " " -NoNewline
        }

        Write-Host "[$count] $(Get-Date -Format 'HH:mm:ss.fff') | " -NoNewline -ForegroundColor Gray
        Write-Host "$title" -NoNewline -ForegroundColor $color
        Write-Host " (PID: $procId, Process: $procName)" -ForegroundColor DarkGray

        $last = $current
    }
    Start-Sleep -Milliseconds 50
}
