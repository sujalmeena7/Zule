import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'crypto';

// Razorpay signs the RAW request body bytes. Vercel's default body parser
// re-serializes JSON (different key order/whitespace/escaping), which makes
// every signature check fail against a re-stringified body. We take over
// body parsing ourselves and HMAC the exact bytes Razorpay sent.
export const config = {
  api: {
    bodyParser: false,
  },
};

function ensureFirebaseAdmin() {
  if (getApps().length === 0) {
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
    privateKey = privateKey.trim();
    if (
      (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
      (privateKey.startsWith("'") && privateKey.endsWith("'"))
    ) {
      privateKey = privateKey.slice(1, -1);
    }
    privateKey = privateKey.replace(/\\n/g, '\n');

    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID?.trim(),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL?.trim(),
        privateKey,
      }),
    });
  }
}

function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  ensureFirebaseAdmin();

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('Webhook secret not configured');
    return res.status(500).json({ error: 'Configuration error' });
  }

  const signature = req.headers['x-razorpay-signature'];
  if (!signature || typeof signature !== 'string') {
    return res.status(400).json({ error: 'Missing signature' });
  }

  const rawBody = await readRawBody(req);

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedSignature, 'hex');
  const providedBuf = Buffer.from(signature, 'hex');

  // Constant-time comparison to prevent timing attacks
  const signatureValid =
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!signatureValid) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let body: { event?: string; payload?: any };
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const event = body.event;
  const payload = body.payload;

  // Idempotency: deduplicate webhook deliveries
  const eventId = req.headers['x-razorpay-event-id'];
  if (eventId && typeof eventId === 'string') {
    try {
      await getFirestore()
        .collection('webhookEvents')
        .doc(eventId)
        .create({
          event: event ?? null,
          receivedAt: FieldValue.serverTimestamp(),
        });
    } catch (err: any) {
      if (err?.code === 6 /* ALREADY_EXISTS */) {
        return res.status(200).json({ status: 'ok', duplicate: true });
      }
      throw err;
    }
  }

  try {
    if (event === 'subscription.charged' || event === 'subscription.activated') {
      const subscription = payload.subscription.entity;
      const uid = subscription.notes?.uid;
      const plan = subscription.notes?.plan;
      const interval = subscription.notes?.interval;

      if (uid && plan) {
        await getFirestore().collection('users').doc(uid).collection('subscription').doc('current').set({
          plan: plan,
          status: 'active',
          interval: interval || 'monthly',
          subscriptionId: subscription.id,
          updatedAt: FieldValue.serverTimestamp(),
          paymentId: payload.payment?.entity?.id || null,
        });
      }
    } else if (event === 'subscription.cancelled' || event === 'subscription.halted') {
      const subscription = payload.subscription.entity;
      const uid = subscription.notes?.uid;

      if (uid) {
        await getFirestore().collection('users').doc(uid).collection('subscription').doc('current').update({
          status: 'cancelled',
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    return res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
