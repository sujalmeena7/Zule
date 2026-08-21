# ============================================
# Simulates a capture-protected app (like Unstop SmartHire)
# ============================================
# Creates a window with SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
# Normal screen capture will see a BLACK window.
# BitBlt from GetDC(NULL) should still see the content.
#
# Usage: .\scripts\protected-window.ps1
# Then test zule's "Use Screen" against this window.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CaptureProtection {
    [DllImport("user32.dll")]
    public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    
    public const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
}
"@

# Create a form with visible text (simulating exam question)
$form = New-Object System.Windows.Forms.Form
$form.Text = "SIMULATED EXAM - Protected Window (Like Unstop SmartHire)"
$form.Size = New-Object System.Drawing.Size(800, 600)
$form.StartPosition = "CenterScreen"
$form.BackColor = [System.Drawing.Color]::White

# Add a label with a fake exam question
$label = New-Object System.Windows.Forms.Label
$label.Text = @"
QUESTION 1 of 10

Given a binary tree, find the number of parent nodes that have
both left and right children with values of the node itself,
its left child, and its right child summing to K.

Input: N = 7, K = 15
Tree: [5, 3, 7, 2, 1, 6, 8]

What is the count of such parent nodes?

A) 1
B) 2
C) 3
D) 0
"@
$label.Font = New-Object System.Drawing.Font("Segoe UI", 14)
$label.Location = New-Object System.Drawing.Point(30, 30)
$label.Size = New-Object System.Drawing.Size(740, 500)
$form.Controls.Add($label)

# Show the form first
$form.Show()

# Apply capture protection AFTER showing (same as Unstop does)
$hwnd = $form.Handle
$result = [CaptureProtection]::SetWindowDisplayAffinity($hwnd, [CaptureProtection]::WDA_EXCLUDEFROMCAPTURE)

if ($result) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  PROTECTED WINDOW ACTIVE" -ForegroundColor Green  
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "This window has WDA_EXCLUDEFROMCAPTURE applied." -ForegroundColor Yellow
    Write-Host "Normal screen capture will show BLACK for this window." -ForegroundColor Yellow
    Write-Host "BitBlt from GetDC(NULL) should still capture it." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Now test zule's 'Use Screen' against this window." -ForegroundColor Cyan
    Write-Host "Press Ctrl+C here to close the window when done." -ForegroundColor Gray
} else {
    Write-Host "WARNING: SetWindowDisplayAffinity failed!" -ForegroundColor Red
}

# Keep running until user closes
[System.Windows.Forms.Application]::Run($form)
