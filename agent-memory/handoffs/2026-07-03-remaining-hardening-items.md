# Handoff — remaining low/medium-severity hardening items (2026-07-03)

Context: this is the tail of the production-readiness audit. The five
top-tier items (webhook signature, Firestore rules, key encryption,
CORS/error-leak, dependency bumps) are DONE and deployed — see the
"Production-readiness security audit + fixes (2026-07-03)" entry in
`agent-memory/context/project-context.md` for full detail and
verification results (tsc/eslint/test baselines, which pre-existing
failures to ignore, etc.).

This note hands off the remaining items from that audit's LOW/MEDIUM
list. Prior session ran out of context before starting these — the
investigation below is already done; a fresh session can go straight
to implementation.

**Start the new session with this file** so it doesn't have to
re-discover any of the below.

---

## 1. Loopback OAuth server accepts any origin (MEDIUM)

`electron/main.ts`, inside the `login-via-browser` IPC handler
(~line 349-450), the temporary `http.createServer` at line 355-360:

```ts
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
```

The server binds to `127.0.0.1` on an OS-assigned ephemeral port
(`server.listen(0, '127.0.0.1', ...)`, line 420) and is protected by a
random `stateNonce` (line 352) that the completing request must echo
back — so this isn't trivially exploitable remotely. But `Allow-Origin:
*` plus no `Origin` header validation means any local process/page that
discovers the port (e.g. another Electron app, malware doing a
localhost port scan during the 5-minute window) can attempt the POST.

**Fix**: replace the wildcard with the actual expected origin
(`isDev ? DEV_URL : 'https://zuleai.vercel.app'` — that variable
already exists a few lines below, at line 426, hoist it up) and reject
requests whose `Origin` header doesn't match before parsing the body.
Keep the nonce check as defense-in-depth.

## 2. `unsafe-inline` CSP relaxation for Electron (MEDIUM)

`electron/main.ts:189-218`, `relaxCSPForElectron()`:

```ts
csp.replace(/script-src\s+'self'/, "script-src 'self' 'unsafe-inline'")
```

`index.html:28` already ships a real CSP meta tag with
`script-src 'self' 'wasm-unsafe-eval' https://apis.google.com
https://*.firebaseapp.com` — **no `unsafe-inline` in the source CSP**.
`relaxCSPForElectron()` widens it at runtime via `onHeadersReceived`,
which only fires for real HTTP response headers, not `<meta>` tags —
so in the packaged app (loaded via `loadFile()` / `file://`) this
handler likely never touches the CSP at all; it probably only matters
when `isDev` and the window loads `DEV_URL` (the Vite dev server).

**Before touching this**: confirm what actually breaks if you delete
the `.replace(...)` line entirely (comment out CSP relaxation, launch
both `npm run dev` and a packaged build, check DevTools console for CSP
violations). The comment claiming "Electron's preload needs
'unsafe-inline' for injection" is very likely a misdiagnosis — preload
scripts are not `<script>` tags subject to the page's `script-src`, so
this may be dead/overcautious code fixing a symptom that had a
different real cause (maybe a Vite HMR inline script, or it's simply
unnecessary). If something genuinely needs it, prefer a nonce or hash
over blanket `unsafe-inline`.

## 3. `sandbox: false` on both BrowserWindows (MEDIUM)

Two locations, same `preload.ts`:
- `electron/main.ts:315` (main dashboard window)
- `electron/overlayManager.ts:164` (overlay window)

Checked `electron/preload.ts` — it only imports `{ contextBridge,
ipcRenderer }` from `'electron'` plus a type-only import; no direct
`fs`/`path`/`child_process`/Node built-ins. That's exactly the shape a
sandboxed preload script supports fine (sandboxed preloads still get
`contextBridge`/`ipcRenderer`). So flipping both to `sandbox: true` is
likely a safe, low-risk hardening — but must be manually tested end to
end on Windows (the target platform per `electron-builder.yml`):
screen capture / overlay stealth behavior, auth flow, IPC round-trips,
local Whisper transcription, knowledge-base uploads. If anything breaks,
bisect by checking whether `whisperService.ts` or any other main-process
module assumes preload has broader Node access than contextBridge
exposes.

## 4. Unsigned Windows installer (LOW, but real)

`electron-builder.yml` has no `win.certificateFile` /
`certificatePassword` / `signAndEditExecutable` / signing config at
all. This is **not a pure code fix** — it needs a code-signing
certificate (EV or OV, from a CA, or a service like Azure Trusted
Signing / SignPath.io) and the user's account/credentials/budget
decision. Flag this back to the user rather than silently picking a
vendor. Once they have a cert: wire it into the `win:` block per
electron-builder's docs (`certificateFile`, `certificatePassword`, or
`certificateSubjectName` + a signing tool for HSM-based certs like
Azure Trusted Signing).

## 5. Committed junk file

`1000107894.mp4` — 4.0 MB, tracked at the repo root (confirmed via
`git ls-files`). No other stray `.log`/`test_output*` files are
currently tracked (checked — clean). Fix: `git rm 1000107894.mp4`,
commit, and add a `*.mp4` (or more targeted) rule to `.gitignore` if
these get dropped in by screen-recording test runs regularly.

---

## Suggested order for the new session

1. Junk file removal (#5) — trivial, zero risk, do first.
2. Loopback CORS fix (#1) — small, well-scoped, no ambiguity.
3. Sandbox flip (#3) — needs a real test pass after the code change;
   budget time for manual verification on Windows.
4. CSP investigation (#2) — needs the "does removing this break
   anything" experiment before deciding the fix shape.
5. Code signing (#4) — surface to the user; don't implement blind.

After each fix, re-run the same verification the prior session used:
`npx tsc -b` / `npm run lint` / `npm test`, diffed against the known
baseline (100 pre-existing tsc errors, pre-existing lint hits, 6
pre-existing test failures in `dualModeOverlay.*.test.ts` — see the
project-context.md entry for the exact list) so new regressions are
obvious. Append a one-line entry to
`agent-memory/context/project-context.md` per this project's CLAUDE.md
rule when done.
