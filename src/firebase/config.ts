// ============================================
// Zule AI — Firebase Configuration
// ============================================

import { initializeApp } from 'firebase/app';
import { getAuth, browserLocalPersistence, setPersistence } from 'firebase/auth';

// Firebase config — these are public client-side keys (safe to commit)
const firebaseConfig = {
  apiKey: "AIzaSyDExample_REPLACE_WITH_YOUR_KEY",
  authDomain: "zule-ai.firebaseapp.com",
  projectId: "zule-ai",
  storageBucket: "zule-ai.firebasestorage.app",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef123456"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Persist auth state across app restarts (works in Electron too)
setPersistence(auth, browserLocalPersistence);

export default app;
