// ============================================
// Zule AI — Phone Server Unit Tests
// ============================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import {
  startPhoneServer,
  stopPhoneServer,
  isPhoneServerRunning,
  onPhoneImage,
  getLocalIpAddress,
  broadcastAnswer,
  getAnswerHistory,
  clearAnswerHistory,
  type PhoneImageData,
  type PhoneAnswerData,
} from '../phoneServer';

describe('Phone Camera HTTP Server', () => {
  beforeEach(() => {
    stopPhoneServer();
  });

  afterEach(() => {
    stopPhoneServer();
  });

  it('detects a valid local IP address', () => {
    const ip = getLocalIpAddress();
    expect(typeof ip).toBe('string');
    expect(ip.length).toBeGreaterThan(0);
    // Should be valid IPv4 structure
    expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });

  it('starts and stops the server cleanly', async () => {
    expect(isPhoneServerRunning()).toBe(false);

    const info = await startPhoneServer(19473);
    expect(isPhoneServerRunning()).toBe(true);
    expect(info.port).toBeGreaterThanOrEqual(19473);
    expect(info.localIp).toBeDefined();
    expect(info.qrUrl).toBe(`http://${info.localIp}:${info.port}`);

    stopPhoneServer();
    expect(isPhoneServerRunning()).toBe(false);
  });

  it('serves the mobile HTML page on GET /', async () => {
    const info = await startPhoneServer(19474);

    const response = await new Promise<{ statusCode: number; data: string }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${info.port}/`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, data }));
        res.on('error', reject);
      });
    });

    expect(response.statusCode).toBe(200);
    expect(response.data).toContain('<!DOCTYPE html>');
    expect(response.data).toContain('Zule');
  });

  it('handles GET /status', async () => {
    const info = await startPhoneServer(19475);

    const response = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${info.port}/status`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: JSON.parse(data) }));
        res.on('error', reject);
      });
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.server).toBe('zule-phone-server');
  });

  it('accepts POST /upload and invokes onPhoneImage listeners', async () => {
    const info = await startPhoneServer(19476);

    let receivedImage: PhoneImageData | null = null;
    const unsubscribe = onPhoneImage((data) => {
      receivedImage = data;
    });

    const testImageData = Buffer.from('FAKE-JPEG-IMAGE-DATA-FOR-TESTING');

    const response = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${info.port}/upload`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'image/jpeg',
            'Content-Length': testImageData.length,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: JSON.parse(data) }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.write(testImageData);
      req.end();
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(receivedImage).not.toBeNull();
    expect(receivedImage!.mimeType).toBe('image/jpeg');
    expect(Buffer.from(receivedImage!.base64, 'base64').toString()).toBe('FAKE-JPEG-IMAGE-DATA-FOR-TESTING');

    unsubscribe();
  });

  it('serves the Service Worker script on GET /sw.js', async () => {
    const info = await startPhoneServer(19478);

    const response = await new Promise<{ statusCode: number; contentType: string; data: string }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${info.port}/sw.js`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode || 0,
            contentType: res.headers['content-type'] || '',
            data,
          }),
        );
        res.on('error', reject);
      });
    });

    expect(response.statusCode).toBe(200);
    expect(response.contentType).toContain('application/javascript');
    expect(response.data).toContain('notificationclick');
  });

  it('broadcasts answers, stores in ring buffer, and serves on GET /answers', async () => {
    const info = await startPhoneServer(19479);

    const broadcastResult = broadcastAnswer({
      id: 'test-ans-1',
      text: 'This is the AI answer to your question',
      question: 'What is 2 + 2?',
      mode: 'exam',
    });

    expect(broadcastResult.seq).toBeGreaterThan(0);
    expect(getAnswerHistory().length).toBeGreaterThan(0);

    const response = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${info.port}/answers`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: JSON.parse(data) }));
        res.on('error', reject);
      });
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(Array.isArray(response.body.answers)).toBe(true);
    const last = response.body.answers[response.body.answers.length - 1];
    expect(last.text).toBe('This is the AI answer to your question');
    expect(last.question).toBe('What is 2 + 2?');
    expect(last.mode).toBe('exam');
  });

  it('caps ring buffer history at 30 items with FIFO eviction', async () => {
    await startPhoneServer(19480);

    clearAnswerHistory();

    // Broadcast 35 items
    for (let i = 1; i <= 35; i++) {
      broadcastAnswer({
        id: `item-${i}`,
        text: `Answer #${i}`,
        question: `Question #${i}`,
      });
    }

    const history = getAnswerHistory();
    expect(history.length).toBe(30);
    // Oldest should be item-6, newest item-35
    expect(history[0].id).toBe('item-6');
    expect(history[history.length - 1].id).toBe('item-35');
  });

  it('streams live answers to connected SSE clients on GET /events', async () => {
    const info = await startPhoneServer(19481);

    const receivedChunks: string[] = [];

    const req = http.get(`http://127.0.0.1:${info.port}/events`, (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      res.on('data', (chunk) => {
        receivedChunks.push(chunk.toString());
      });
    });
    req.on('error', () => {});

    // Wait for connection handshake
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (receivedChunks.join('').includes('connected') || Date.now() - start > 1000) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    // Broadcast a test answer
    broadcastAnswer({
      id: 'stream-test-1',
      text: 'Live streamed answer over SSE',
      question: 'Testing SSE streaming',
    });

    await new Promise<void>((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (receivedChunks.join('').includes('Live streamed answer over SSE') || Date.now() - start > 1000) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    req.destroy();

    const fullStream = receivedChunks.join('');
    expect(fullStream).toContain('event: connected');
    expect(fullStream).toContain('event: answer');
    expect(fullStream).toContain('Live streamed answer over SSE');
  });

  it('replays missed answers when Last-Event-ID header is provided to GET /events', async () => {
    const info = await startPhoneServer(19482);

    clearAnswerHistory();

    const ans1 = broadcastAnswer({ text: 'Answer 1' });
    const ans2 = broadcastAnswer({ text: 'Answer 2' });
    const ans3 = broadcastAnswer({ text: 'Answer 3' });

    // Connect with Last-Event-ID = ans1.seq, expect to receive ans2 and ans3
    const receivedChunks: string[] = [];

    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: info.port,
        path: '/events',
        headers: {
          'Last-Event-ID': String(ans1.seq),
        },
      },
      (res) => {
        res.on('data', (chunk) => {
          receivedChunks.push(chunk.toString());
        });
      },
    );
    req.on('error', () => {});

    await new Promise<void>((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (receivedChunks.join('').includes('Answer 3') || Date.now() - start > 1000) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });
    req.destroy();

    const fullStream = receivedChunks.join('');
    expect(fullStream).not.toContain('Answer 1');
    expect(fullStream).toContain('Answer 2');
    expect(fullStream).toContain('Answer 3');
  });

  it('rejects uploads exceeding 5MB with 413 Payload Too Large', async () => {
    const info = await startPhoneServer(19477);

    // Over 5MB payload
    const oversizedPayload = Buffer.alloc(5.5 * 1024 * 1024);

    const response = await new Promise<{ statusCode: number }>((resolve) => {
      const req = http.request(
        `http://127.0.0.1:${info.port}/upload`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'image/jpeg',
            'Content-Length': oversizedPayload.length,
          },
        },
        (res) => {
          resolve({ statusCode: res.statusCode || 0 });
        },
      );
      req.on('error', () => {
        // Connection may be destroyed by server on 413, which is valid
        resolve({ statusCode: 413 });
      });
      req.write(oversizedPayload);
      req.end();
    });

    expect(response.statusCode).toBe(413);
  });
});
