// ============================================
// Zule AI — Phone Camera HTTP Server
// ============================================
//
// Minimal local HTTP server in the Electron main process.
// Serves a mobile-friendly web app on LAN and accepts image uploads
// from smartphones to feed physical screen/question photos to Zule AI.

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Max allowed image upload size: 5 MB
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const DEFAULT_PORT = 9473;
const MAX_PORT_ATTEMPTS = 10;

export interface PhoneImageData {
  base64: string;
  mimeType: string;
}

type ImageListener = (data: PhoneImageData) => void;

let server: http.Server | null = null;
let activePort = 0;
let activeIp = '';
const listeners = new Set<ImageListener>();

/**
 * Find the primary local LAN IPv4 address.
 * Prioritizes standard private ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x).
 */
export function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name];
    if (!list) continue;

    for (const net of list) {
      if (net.family === 'IPv4' && !net.internal) {
        if (net.address.startsWith('192.168.') || net.address.startsWith('10.')) {
          return net.address;
        }
        if (net.address.startsWith('172.')) {
          const second = parseInt(net.address.split('.')[1], 10);
          if (second >= 16 && second <= 31) {
            return net.address;
          }
        }
        candidates.push(net.address);
      }
    }
  }

  return candidates[0] || '127.0.0.1';
}

/**
 * Load the mobile web page HTML from disk with safe fallback.
 */
function loadMobilePageHtml(): string {
  const candidates = [
    path.join(__dirname, 'phonePage.html'),
    path.join(__dirname, '../electron/phonePage.html'),
    path.join(process.cwd(), 'electron/phonePage.html'),
  ];

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
    } catch {
      // Continue searching
    }
  }

  // Minimal inline fallback if file is not found
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zule Phone Camera</title></head><body style="background:#0f172a;color:#fff;font-family:sans-serif;text-align:center;padding:20px"><h2>Zule AI Camera</h2><input type="file" accept="image/*" capture="environment" id="i" style="display:none"><button onclick="document.getElementById('i').click()" style="padding:16px 24px;font-size:18px;border-radius:12px;background:#2563eb;color:#fff;border:none">📸 Take Photo</button><script>document.getElementById('i').onchange=e=>{const f=e.target.files[0];if(f){fetch('/upload',{method:'POST',headers:{'Content-Type':'image/jpeg'},body:f}).then(()=>alert('Photo sent to Zule!'))}};</script></body></html>`;
}

/**
 * Create request handler for the phone server.
 */
function createRequestHandler() {
  const htmlContent = loadMobilePageHtml();

  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Add CORS headers for LAN clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Length');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || '/';

    // GET / or /index.html -> serve mobile capture page
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(htmlContent);
      return;
    }

    // GET /status -> health check
    if (req.method === 'GET' && url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'zule-phone-server', port: activePort }));
      return;
    }

    // POST /upload -> accept JPEG image upload
    if (req.method === 'POST' && url === '/upload') {
      const contentType = req.headers['content-type'] || 'image/jpeg';
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);

      if (contentLength > MAX_UPLOAD_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Image exceeds 5MB size limit' }));
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let isAborted = false;

      req.on('data', (chunk: Buffer) => {
        if (isAborted) return;
        totalBytes += chunk.length;

        if (totalBytes > MAX_UPLOAD_BYTES) {
          isAborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Image exceeds 5MB size limit' }));
          req.destroy();
          return;
        }

        chunks.push(chunk);
      });

      req.on('end', () => {
        if (isAborted) return;

        if (chunks.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No image data received' }));
          return;
        }

        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        const mimeType = contentType.split(';')[0].trim() || 'image/jpeg';

        console.log(`[phoneServer] Received image: ${buffer.length} bytes, mimeType: ${mimeType}`);

        // Broadcast to listeners
        const payload: PhoneImageData = { base64, mimeType };
        for (const listener of listeners) {
          try {
            listener(payload);
          } catch (err) {
            console.error('[phoneServer] Error in image listener:', err);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Image received by Zule AI' }));
      });

      req.on('error', (err) => {
        console.error('[phoneServer] Request error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });

      return;
    }

    // 404 for all other routes
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  };
}

/**
 * Try listening on a specific port.
 */
function tryListen(srv: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (err: any) => {
      srv.removeListener('error', onError);
      srv.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        console.error(`[phoneServer] Listen error on port ${port}:`, err);
        resolve(false);
      }
    };

    const onListening = () => {
      srv.removeListener('error', onError);
      srv.removeListener('listening', onListening);
      resolve(true);
    };

    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, '0.0.0.0');
  });
}

/**
 * Start the local phone camera HTTP server.
 * Tries default port 9473, falling back to 9474..9483 if in use.
 */
export async function startPhoneServer(
  preferredPort = DEFAULT_PORT,
): Promise<{ port: number; localIp: string; qrUrl: string }> {
  // If already running, return current connection info
  if (server && activePort > 0) {
    const ip = getLocalIpAddress();
    activeIp = ip;
    return {
      port: activePort,
      localIp: ip,
      qrUrl: `http://${ip}:${activePort}`,
    };
  }

  const srv = http.createServer(createRequestHandler());

  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
    const port = preferredPort + offset;
    const ok = await tryListen(srv, port);
    if (ok) {
      server = srv;
      activePort = port;
      activeIp = getLocalIpAddress();
      const qrUrl = `http://${activeIp}:${activePort}`;
      console.log(`[phoneServer] Phone capture server listening on ${qrUrl}`);
      return { port: activePort, localIp: activeIp, qrUrl };
    }
  }

  throw new Error(`Failed to bind phone server on ports ${preferredPort}..${preferredPort + MAX_PORT_ATTEMPTS - 1}`);
}

/**
 * Stop the local phone camera server.
 */
export function stopPhoneServer(): void {
  if (server) {
    try {
      server.close();
      console.log('[phoneServer] Phone capture server stopped');
    } catch (err) {
      console.warn('[phoneServer] Error stopping server:', err);
    }
    server = null;
    activePort = 0;
  }
}

/**
 * Check if the phone server is currently active.
 */
export function isPhoneServerRunning(): boolean {
  return server !== null && activePort > 0;
}

/**
 * Get current server status and URL info.
 */
export function getPhoneServerInfo(): {
  running: boolean;
  port: number;
  localIp: string;
  qrUrl: string;
} {
  const running = isPhoneServerRunning();
  const ip = running ? activeIp || getLocalIpAddress() : '';
  const qrUrl = running ? `http://${ip}:${activePort}` : '';
  return {
    running,
    port: activePort,
    localIp: ip,
    qrUrl,
  };
}

/**
 * Register a listener for incoming phone images.
 * Returns an unsubscribe callback.
 */
export function onPhoneImage(cb: ImageListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
