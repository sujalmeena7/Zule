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
  type PhoneImageData,
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
