// ============================================
// Zule AI — UI Automation Text Extraction
// ============================================
//
// Extracts text from the foreground window using Windows UI Automation
// (the Accessibility API). This bypasses SetWindowDisplayAffinity because
// display affinity only blocks PIXEL capture — it does NOT block the
// accessibility tree which provides programmatic access to UI text content.
//
// Implementation: spawns a short-lived PowerShell process that uses .NET's
// System.Windows.Automation to walk the UI tree of the foreground window
// and collect all text elements.
//
// This is the same API that screen readers (NVDA, JAWS, Narrator) use.
// No app can block it without breaking accessibility compliance.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// PowerShell script that extracts all text from the foreground window's UI tree
const PS_SCRIPT = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$auto = [System.Windows.Automation.AutomationElement]

# Get the foreground window
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
"@

$hwnd = [Win32]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output ""
    exit
}

try {
    $element = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $element) {
        Write-Output ""
        exit
    }

    # Walk all descendants and collect text
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $scope = [System.Windows.Automation.TreeScope]::Descendants
    $elements = $element.FindAll($scope, $condition)

    $texts = @()
    foreach ($el in $elements) {
        try {
            # Try TextPattern first (rich text controls)
            $textPattern = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
            if ($null -ne $textPattern) {
                $text = $textPattern.DocumentRange.GetText(-1)
                if ($text -and $text.Trim().Length -gt 0) {
                    $texts += $text.Trim()
                }
                continue
            }
        } catch {}

        try {
            # Try ValuePattern (input fields, editable text)
            $valuePattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            if ($null -ne $valuePattern) {
                $val = $valuePattern.Current.Value
                if ($val -and $val.Trim().Length -gt 0) {
                    $texts += $val.Trim()
                }
                continue
            }
        } catch {}

        # Fall back to Name property (labels, buttons, static text)
        try {
            $name = $el.Current.Name
            if ($name -and $name.Trim().Length -gt 0 -and $name.Length -lt 2000) {
                $texts += $name.Trim()
            }
        } catch {}
    }

    # Output unique texts joined by newlines
    $unique = $texts | Select-Object -Unique
    $result = $unique -join [Environment]::NewLine
    Write-Output $result
} catch {
    Write-Output ""
}
`;

/**
 * Extract all visible text from the foreground window using Windows
 * UI Automation (accessibility API). Returns the concatenated text or
 * null if extraction failed.
 *
 * This bypasses SetWindowDisplayAffinity — display affinity only blocks
 * pixel-level screen capture, not programmatic UI tree access.
 *
 * Typical execution time: 200-500ms for a moderately complex window.
 */
export async function extractForegroundText(): Promise<string | null> {
  if (process.platform !== 'win32') return null;

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      {
        timeout: 5000, // 5s max — if UI tree is huge, bail out
        maxBuffer: 1024 * 1024, // 1MB of text output
        windowsHide: true, // Don't show PowerShell window
      },
    );

    const text = stdout.trim();
    return text.length > 0 ? text : null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[UIAutomation] Text extraction failed: ${msg}`);
    return null;
  }
}
