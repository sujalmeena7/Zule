// ============================================
// Zule AI — Firebase Configuration
// ============================================

import { initializeApp } from 'firebase/app';
import { getAuth, browserLocalPersistence, setPersistence } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyAPlJ2c1qBHs1Fgi7WVApUb7VElOQCg8X0",
  authDomain: "zule-ai.firebaseapp.com",
  projectId: "zule-ai",
  storageBucket: "zule-ai.firebasestorage.app",
  messagingSenderId: "380167824125",
  appId: "1:380167824125:web:8a26d7e510f6406c1f9494",
  measurementId: "G-VYVVD6R92Z"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Persist auth state across app restarts (works in Electron too)
setPersistence(auth, browserLocalPersistence);

export default app;
