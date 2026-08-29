// ============================================
// Zule AI — Phone Camera & Answer HTTP Server
// ============================================
//
// Minimal local HTTP server in the Electron main process.
// Serves a mobile-friendly web app on LAN, accepts image uploads
// from smartphones to feed physical screen/question photos to Zule AI,
// and streams live AI-generated answers back to the phone via SSE.

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
const MAX_ANSWER_HISTORY = 30;

export interface PhoneImageData {
  base64: string;
  mimeType: string;
}

export interface PhoneAnswerData {
  id: string;
  seq: number;
  text: string;
  question?: string;
  mode?: string;
  model?: string;
  timestamp: number;
}

type ImageListener = (data: PhoneImageData) => void;

let server: http.Server | null = null;
let activePort = 0;
let activeIp = '';
const listeners = new Set<ImageListener>();
const sseClients = new Set<http.ServerResponse>();
const answerHistory: PhoneAnswerData[] = [];
let nextSeq = 1;
let heartbeatTimer: NodeJS.Timeout | null = null;

/** Service worker script for mobile background notifications and click focus */
const SW_SCRIPT = `
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});
`.trim();

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
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zule Phone Companion</title></head><body style="background:#0f172a;color:#fff;font-family:sans-serif;text-align:center;padding:20px"><h2>Zule AI Companion</h2><p>Page template loading...</p></body></html>`;
}

let activePushTopic = '';

export function getPushTopic(): string {
  if (!activePushTopic) {
    activePushTopic = `zule-${Math.random().toString(36).slice(2, 10)}`;
  }
  return activePushTopic;
}

/**
 * Broadcast an AI answer to all connected mobile clients over SSE, forward to secure lock-screen push, and persist in history.
 */
export function broadcastAnswer(data: {
  id?: string;
  text: string;
  question?: string;
  mode?: string;
  model?: string;
  timestamp?: number;
}): { sent: number; seq: number } {
  const seq = nextSeq++;
  const payload: PhoneAnswerData = {
    id: data.id || `ans-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    seq,
    text: data.text,
    question: data.question,
    mode: data.mode,
    model: data.model,
    timestamp: data.timestamp || Date.now(),
  };

  // Add to ring buffer (capped at MAX_ANSWER_HISTORY)
  answerHistory.push(payload);
  if (answerHistory.length > MAX_ANSWER_HISTORY) {
    answerHistory.shift();
  }

  const sseMessage = `id: ${seq}\nevent: answer\ndata: ${JSON.stringify(payload)}\n\n`;

  let sentCount = 0;
  for (const client of sseClients) {
    try {
      client.write(sseMessage);
      sentCount++;
    } catch (err) {
      console.warn('[phoneServer] Error writing to SSE client:', err);
      sseClients.delete(client);
    }
  }

  // Forward to secure HTTPS lock-screen push (ntfy.sh) if pushTopic exists
  const topic = getPushTopic();
  if (topic) {
    try {
      const q = data.question ? `Q: ${data.question.slice(0, 60)}` : 'Zule AI Copilot';
      const companionUrl = activeIp && activePort ? `http://${activeIp}:${activePort}` : undefined;
      const headers: Record<string, string> = {
        'Title': q,
        'X-Title': q,
        'Priority': '5', // 5 / urgent: forces immediate FCM/APNs wakeup, bypassing Android Doze delays
        'X-Priority': '5',
        'Tags': 'robot,zap',
        'X-Tags': 'robot,zap',
      };
      if (companionUrl) {
        headers['Click'] = companionUrl;
        headers['X-Click'] = companionUrl;
      }

      fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        headers,
        body: data.text,
      }).catch((err) => {
        console.warn('[phoneServer] Lock-screen push dispatch error (non-fatal):', err);
      });
    } catch {
      // Ignore network errors
    }
  }

  return { sent: sentCount, seq };
}

/**
 * Get recent answer history from the ring buffer.
 */
export function getAnswerHistory(): PhoneAnswerData[] {
  return [...answerHistory];
}

/**
 * Clear answer history (useful for test resets).
 */
export function clearAnswerHistory(): void {
  answerHistory.length = 0;
  nextSeq = 1;
}

/**
 * Get count of connected SSE mobile clients.
 */
export function getConnectedClientCount(): number {
  return sseClients.size;
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Length, Last-Event-ID');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;

    // GET / or /index.html -> serve mobile capture & answer page
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(htmlContent);
      return;
    }

    // GET /sw.js -> serve Service Worker script for mobile background notifications
    if (req.method === 'GET' && pathname === '/sw.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(SW_SCRIPT);
      return;
    }

    // GET /status -> health check
    if (req.method === 'GET' && pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          server: 'zule-phone-server',
          port: activePort,
          pushTopic: getPushTopic(),
          connectedClients: sseClients.size,
          answerCount: answerHistory.length,
        }),
      );
      return;
    }

    // GET /answers -> fetch recent answer history
    if (req.method === 'GET' && pathname === '/answers') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify({ ok: true, answers: answerHistory }));
      return;
    }

    // GET /events -> Server-Sent Events (SSE) stream for live answers
    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Configure auto-reconnect backoff on client
      res.write('retry: 3000\n\n');

      // Check for Last-Event-ID header or query param for reconnection replay
      const lastEventIdHeader = req.headers['last-event-id'];
      const lastEventIdParam = reqUrl.searchParams.get('lastEventId');
      const lastEventIdStr = (Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader) || lastEventIdParam;
      const lastEventId = lastEventIdStr ? parseInt(lastEventIdStr, 10) : 0;

      if (!isNaN(lastEventId) && lastEventId > 0) {
        // Replay missed messages from ring buffer
        const missed = answerHistory.filter((item) => item.seq > lastEventId);
        for (const item of missed) {
          res.write(`id: ${item.seq}\nevent: answer\ndata: ${JSON.stringify(item)}\n\n`);
        }
      }

      // Initial ping / connected acknowledgement
      res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, clientCount: sseClients.size + 1 })}\n\n`);

      sseClients.add(res);

      const cleanup = () => {
        sseClients.delete(res);
      };

      req.on('close', cleanup);
      res.on('error', cleanup);
      return;
    }

    // POST /upload -> accept JPEG image upload
    if (req.method === 'POST' && pathname === '/upload') {
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
 * Start periodic keepalive heartbeat ping to prevent connection drops on mobile carriers / routers.
 */
function startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': keepalive\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, 20000);
}

/**
 * Stop heartbeat timer.
 */
function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Start the local phone camera & companion HTTP server.
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
      startHeartbeat();
      const qrUrl = `http://${activeIp}:${activePort}`;
      console.log(`[phoneServer] Phone capture & answer server listening on ${qrUrl}`);
      return { port: activePort, localIp: activeIp, qrUrl };
    }
  }

  throw new Error(`Failed to bind phone server on ports ${preferredPort}..${preferredPort + MAX_PORT_ATTEMPTS - 1}`);
}

/**
 * Stop the local phone companion server.
 */
export function stopPhoneServer(): void {
  stopHeartbeat();

  // Close active SSE client connections cleanly
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      // Ignore
    }
  }
  sseClients.clear();

  if (server) {
    try {
      server.close();
      console.log('[phoneServer] Phone companion server stopped');
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
  connectedClients: number;
} {
  const running = isPhoneServerRunning();
  const ip = running ? activeIp || getLocalIpAddress() : '';
  const qrUrl = running ? `http://${ip}:${activePort}` : '';
  return {
    running,
    port: activePort,
    localIp: ip,
    qrUrl,
    connectedClients: sseClients.size,
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
