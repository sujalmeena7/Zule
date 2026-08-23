# Phone Camera Input — Implementation Plan

## Overview
Allow users to take a photo from their phone and send it to the Zule desktop overlay over the local network. The AI vision model reads the photo and answers the question shown in it. This bypasses all software-level screen capture protections since it captures the physical screen via an external device.

## Architecture

```
[Phone Browser] --HTTP POST (image/jpeg)--> [Zule Main Process HTTP Server]
                                                    |
                                                    v
                                            [IPC to Overlay Renderer]
                                                    |
                                                    v
                                            [Vision Model API Call]
                                                    |
                                                    v
                                            [Answer displayed in overlay]
```

## Components to Build

### 1. Local HTTP Server (`electron/phoneServer.ts`)

**What:** A minimal HTTP server in the Electron main process that serves a mobile-friendly web page and accepts image uploads.

**Specs:**
- Bind to `0.0.0.0` on a fixed port (e.g. `9473`) so it's accessible from any device on the same LAN
- Serve a single-page HTML/JS app at `GET /` (the phone opens this)
- Accept `POST /upload` with `multipart/form-data` containing a JPEG image
- On image received: forward to the overlay renderer via IPC channel `phone-image-received`
- CORS: allow all origins (it's local network only)
- Start when a copilot session starts, stop when it ends
- No authentication needed (LAN-only, ephemeral)

**API:**
```typescript
export function startPhoneServer(): { port: number; localIp: string };
export function stopPhoneServer(): void;
```

### 2. Mobile Web Page (served inline from the server, no separate files)

**What:** A minimal responsive HTML page that the phone browser loads. Uses the phone's camera to take a photo and uploads it.

**UI Elements:**
- Large "📸 Take Photo" button (opens rear camera)
- Preview of the captured image
- "Send to Zule" button (uploads to the server)
- Status text: "Connected", "Sending...", "Sent ✓"
- Auto-send option: automatically send after capture (no second tap needed)

**Tech:**
- `<input type="file" accept="image/*" capture="environment">` for rear camera
- Or `navigator.mediaDevices.getUserMedia` for live preview + capture
- `fetch('/upload', { method: 'POST', body: formData })` to send
- Resize image client-side to max 1920px before upload (reduce transfer time)
- Pure HTML/CSS/JS — no framework, no build step. Served as a string from the Node server.

### 3. IPC Integration (`electron/main.ts` additions)

**New IPC handlers:**
- `ipcMain.handle('phone-server-start')` — starts the server, returns `{ port, localIp, qrUrl }`
- `ipcMain.handle('phone-server-stop')` — stops the server
- `ipcMain.on('phone-image-received')` — forwarded to overlay renderer

**Server → Renderer flow:**
When an image arrives at `POST /upload`:
1. Read the image buffer
2. Convert to base64
3. Send to overlay: `overlayWindow.webContents.send('phone-image-received', { base64, mimeType: 'image/jpeg' })`

### 4. Preload Bridge (`electron/preload.ts` additions)

```typescript
// Start the phone server and get connection info
startPhoneServer: () => Promise<{ port: number; localIp: string; qrUrl: string }>;

// Stop the phone server
stopPhoneServer: () => Promise<void>;

// Listen for incoming phone images
onPhoneImage: (callback: (data: { base64: string; mimeType: string }) => void) => () => void;
```

### 5. Overlay UI Changes (`src/components/copilot/InputBar.tsx` or new component)

**New button:** Add a "📱" phone icon button next to "Use Screen" in the input toolbar.

**On click:**
1. Call `startPhoneServer()`
2. Show a small popup/modal with:
   - The LAN URL: `http://192.168.x.x:9473`
   - A QR code (use a simple QR library or generate SVG inline)
   - "Scan with your phone to send photos"
3. Listen for `onPhoneImage` events

**On image received:**
1. Set `keyframeForContext = { mimeType: 'image/jpeg', base64: receivedImage }`
2. Trigger AI request with the image as context (same pipeline as Use Screen with a keyframe)
3. Show a brief "Photo received ✓" indicator

### 6. FloatingCopilot Integration (`src/components/FloatingCopilot.tsx`)

**New state:**
```typescript
const [phoneServerActive, setPhoneServerActive] = useState(false);
const [phoneServerUrl, setPhoneServerUrl] = useState<string | null>(null);
```

**Phone image handler:**
```typescript
useEffect(() => {
  if (!isElectronEnv) return;
  const cleanup = electronAPI.onPhoneImage((data) => {
    // Treat exactly like a Use Screen keyframe
    // Set the image as context and trigger AI
    setChatHistory(prev => [...prev, { id: generateId(), role: 'user', text: 'Answer the question in this photo' }]);
    triggerAIWithImage(data); // new helper that sets keyframeForContext and calls triggerAI
  });
  return cleanup;
}, []);
```

### 7. TypeScript Types (`src/types/electron.d.ts`)

```typescript
startPhoneServer?: () => Promise<{ port: number; localIp: string; qrUrl: string }>;
stopPhoneServer?: () => Promise<void>;
onPhoneImage?: (callback: (data: { base64: string; mimeType: string }) => void) => () => void;
```

## File Structure

```
electron/
  phoneServer.ts          # HTTP server + mobile page HTML
  main.ts                 # Add IPC handlers + start/stop on session

src/
  components/
    copilot/
      PhoneCapture.tsx    # QR code popup + connection status
      InputBar.tsx        # Add phone button to toolbar
  types/
    electron.d.ts         # Add new API types

electron/
  preload.ts             # Add bridge methods
```

## Implementation Order

1. `electron/phoneServer.ts` — the HTTP server with inline HTML page
2. Wire IPC in `main.ts` — start/stop handlers + image forwarding
3. `preload.ts` — expose the three new methods
4. `src/types/electron.d.ts` — add types
5. `PhoneCapture.tsx` — QR code popup component
6. `InputBar.tsx` — add the phone button
7. `FloatingCopilot.tsx` — handle incoming images, trigger AI

## Dependencies

- **QR code generation:** Use `qrcode` npm package (tiny, no deps) OR generate a QR code as SVG string inline (no new dependency)
- **No new native deps** — Node's built-in `http` module handles the server
- **No phone app needed** — standard mobile browser handles camera + upload

## Edge Cases

- **Multiple devices:** Server accepts from any device. Last image wins.
- **Large images:** Client-side resize to 1920px max before upload. Server rejects >5MB.
- **Server port conflict:** If 9473 is busy, try 9474, 9475, etc.
- **Firewall:** Windows Firewall may prompt on first use. The server only listens on LAN.
- **Session end:** Auto-stop server when copilot session ends.

## Security Notes

- Server is LAN-only (private IP). Not exposed to internet.
- No authentication (acceptable for ephemeral LAN service during exam).
- Image data stays local — goes from phone → LAN → Zule → AI API. Never stored on disk.
- Server only accepts POST with image MIME types. Rejects everything else.

## Testing

1. Start zule, start session
2. Click phone button → QR appears
3. Scan QR with phone → mobile page loads
4. Take photo of any text/question
5. Photo arrives in zule → AI answers the question from the photo
6. Verify: no network traffic leaves the LAN (except the AI API call)
