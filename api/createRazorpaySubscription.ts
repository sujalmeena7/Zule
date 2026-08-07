import type { VercelRequest, VercelResponse } from '@vercel/node';
import admin from 'firebase-admin';
import Razorpay from 'razorpay';

function getFirebaseAdmin() {
  if (!admin.apps.length) {
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
    privateKey = privateKey.trim();
    if (
      (privateKey.startsWith('"') && privateKey.endsWith('"')) ||
      (privateKey.startsWith("'") && privateKey.endsWith("'"))
    ) {
      privateKey = privateKey.slice(1, -1);
    }
    privateKey = privateKey.replace(/\\n/g, '\n');

    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(`Firebase Admin credentials incomplete: projectId=${!!projectId}, clientEmail=${!!clientEmail}, privateKey=${!!privateKey}`);
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  }
  return admin;
}

function getRazorpay() {
  const key_id = (process.env.RAZORPAY_KEY_ID || '').trim().replace(/^["']|["']$/g, '');
  const key_secret = (process.env.RAZORPAY_KEY_SECRET || '').trim().replace(/^["']|["']$/g, '');

  if (!key_id || !key_secret) {
    throw new Error(`Razorpay API keys incomplete: key_id=${!!key_id}, key_secret=${!!key_secret}`);
  }

  return new Razorpay({ key_id, key_secret });
}

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
    const adminApp = getFirebaseAdmin();
    const razorpayClient = getRazorpay();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await adminApp.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;

    const { plan, interval } = req.body;

    if (plan === 'free') {
      await adminApp.firestore().collection('users').doc(uid).collection('subscription').doc('current').set({
        plan: 'free',
        status: 'active',
        interval: 'monthly',
        updatedAt: adminApp.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ success: true, plan: 'free' });
    }

    const planId = RAZORPAY_PLAN_IDS[plan]?.[interval || 'monthly'];
    if (!planId) {
      return res.status(400).json({ error: `Invalid plan (${plan}) or interval (${interval})` });
    }

    const subscription = await razorpayClient.subscriptions.create({
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
    console.error('Error creating subscription:', error);
    const errorMsg = error?.error?.description || error?.message || 'Internal server error';
    return res.status(500).json({ error: errorMsg, details: error?.error || String(error) });
  }
}
