import type { VercelRequest, VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';
import Razorpay from 'razorpay';

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || '',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '',
});

const RAZORPAY_PLAN_IDS: Record<string, Record<string, string>> = {
  pro: {
    monthly: "plan_T8XAQYzrKWI75h",
    annual: "plan_T8XB9QwEfYzWSL",
  },
  ultra: {
    monthly: "plan_T8XBXytkkUUEh2",
    annual: "plan_T8XDzQMzwQ43fP",
  },
};

// Callers: the packaged Electron app (renderer loaded via `mainWindow.loadFile`,
// which serializes to the literal Origin "null"), the Electron dev server, and
// the web app. This endpoint never relies on cookies (auth is a Bearer token
// in the request body/header), so we don't need Access-Control-Allow-Credentials —
// dropping it lets us skip the invalid "wildcard origin + credentials" combo
// that was here before.
const ALLOWED_ORIGINS = new Set([
  'https://zuleai.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'null',
]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers — reflect only an allow-listed origin, never '*'.
  const origin = req.headers.origin;
  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    const { plan, interval } = req.body;

    if (plan === 'free') {
      await admin.firestore().collection('users').doc(uid).collection('subscription').doc('current').set({
        plan: 'free',
        status: 'active',
        interval: 'monthly',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ success: true, plan: 'free' });
    }

    const planId = RAZORPAY_PLAN_IDS[plan]?.[interval || 'monthly'];
    if (!planId) {
      return res.status(400).json({ error: 'Invalid plan or interval' });
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count: interval === 'annual' ? 10 : 120,
      notes: {
        uid: uid,
        plan: plan,
        interval: interval || 'monthly',
      },
    });

    return res.status(200).json({
      success: true,
      subscriptionId: subscription.id,
      shortUrl: subscription.short_url,
    });
  } catch (error: any) {
    // Log the full error server-side only — never forward internal error
    // details (stack traces, Razorpay/Firebase error payloads) to the client.
    console.error('Error creating subscription:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
