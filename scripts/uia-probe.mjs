// Standalone check: does the UI Automation text bypass work on this machine?
//
// Runs the exact PowerShell that `ipcMain.handle('extract-foreground-text')` in
// electron/main.ts runs, against a window this script brings to the foreground.
// Separate from the app so a failure can be read without an Electron log, and so
// the one-strike session breaker in main.ts does not hide the second attempt.
//
// Usage: node scripts/uia-probe.mjs ["window title substring"]
//        defaults to the window created by scripts/protected-window.ps1

import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');

const EnumWindows = user32.func('bool EnumWindows(void *cb, long lp)');
const GetWindowTextA = user32.func('int GetWindowTextA(void *hwnd, void *s, int max)');
const IsWindowVisible = user32.func('bool IsWindowVisible(void *hwnd)');
const SetForegroundWindow = user32.func('bool SetForegroundWindow(void *hwnd)');
const ShowWindow = user32.func('bool ShowWindow(void *hwnd, int cmd)');
const GetForegroundWindow = user32.func('void *GetForegroundWindow()');

const needle = (process.argv[2] ?? 'SIMULATED EXAM').toLowerCase();

/** Title of a window handle, as a JS string. */
function titleOf(hwnd) {
  const buf = Buffer.alloc(512);
  GetWindowTextA(hwnd, buf, 512);
  return buf.toString('latin1').split('\0')[0];
}

let target = null;
const EnumProto = koffi.proto('bool EnumCb(void *hwnd, long lp)');
const cb = koffi.register((hwnd) => {
  if (target) return true;
  if (!IsWindowVisible(hwnd)) return true;
  if (titleOf(hwnd).toLowerCase().includes(needle)) target = hwnd;
  return true;
}, koffi.pointer(EnumProto));
EnumWindows(cb, 0);
koffi.unregister(cb);

if (!target) {
  console.log(`No visible window matching "${needle}". Start scripts/protected-window.ps1 first.`);
  process.exit(1);
}

console.log(`target        "${titleOf(target)}"`);
ShowWindow(target, 9);
SetForegroundWindow(target);
await new Promise((r) => setTimeout(r, 1200));
console.log(`foreground    "${titleOf(GetForegroundWindow())}"`);

// Verbatim copy of the script in electron/main.ts. Kept byte-identical on
// purpose: a probe that differs from the shipped command proves nothing.
const psScript = `Add-Type -A UIAutomationClient,UIAutomationTypes;Add-Type 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}';$h=[W]::GetForegroundWindow();if($h-eq[IntPtr]::Zero){exit};$e=[System.Windows.Automation.AutomationElement]::FromHandle($h);if(!$e){exit};$r=@();foreach($c in $e.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){try{$n=$c.Current.Name;if($n-and$n.Length-gt2-and$n.Length-lt5000){$r+=$n}}catch{}};($r|Select -Unique) -join [char]10`;

const startedAt = Date.now();
try {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const text = stdout.trim();
  console.log(`elapsed       ${Date.now() - startedAt}ms`);
  console.log(`chars         ${text.length}`);
  console.log('');
  console.log(text.length > 0 ? text.slice(0, 1500) : 'VERDICT  no-text — the walk succeeded but found nothing readable.');
} catch (err) {
  const stderr = String(err?.stderr ?? '').trim();
  console.log(`elapsed       ${Date.now() - startedAt}ms`);
  console.log(`killed        ${err?.killed === true} (true => hit the 5s timeout)`);
  console.log(`message       ${String(err?.message ?? err).slice(0, 300)}`);
  console.log(`stderr        ${stderr.length > 0 ? stderr.slice(0, 1200) : '(empty)'}`);
}
