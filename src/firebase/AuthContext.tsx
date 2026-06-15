// ============================================
// Zule AI — Authentication Context
// ============================================

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithCredential,
  GoogleAuthProvider,
  signOut,
  type User,
} from 'firebase/auth';
import { auth } from './config';
import { useElectronBridge } from '../hooks/useElectronBridge';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

const googleProvider = new GoogleAuthProvider();

// Hijack window.open to keep a reference to the popup window so we can
// satisfy Firebase's strict event.source validation.
let currentPopup: Window | null = null;
const originalWindowOpen = window.open;
window.open = function(...args) {
  currentPopup = originalWindowOpen.apply(this, args);
  return currentPopup;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const { isElectron, electron } = useElectronBridge();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  // ── Electron Firebase Auth Relay ──────────────────────────────────────────
  // Listen for the relayed postMessage payload from the popup window and 
  // manually dispatch it on the local window so Firebase Web SDK completes the login!
  useEffect(() => {
    if (isElectron && electron?.onFirebaseAuthMessage) {
      const cleanup = electron.onFirebaseAuthMessage((message) => {
        console.log('[AuthContext] Received Firebase popup payload via IPC relay:', message);
        window.dispatchEvent(new MessageEvent('message', {
          data: message,
          // Firebase strictly checks the origin and source.
          origin: `https://${auth.app.options.authDomain}`,
          source: currentPopup || window
        }));
      });
      return cleanup;
    }
  }, [isElectron, electron]);

  const signIn = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signUp = async (email: string, password: string) => {
    await createUserWithEmailAndPassword(auth, email, password);
  };

  const signInWithGoogle = async () => {
    // In Electron, signInWithPopup needs special handling.
    // The popup window is allowed via setWindowOpenHandler in main.ts.
    // We need to ensure the popup can communicate back.
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: unknown) {
      // If popup fails (common in Electron), try with redirect as fallback
      const message = err instanceof Error ? err.message : '';
      if (message.includes('popup') || message.includes('cross-origin')) {
        // Fallback: open Google OAuth URL in system browser isn't practical
        // for getting the token back. Re-throw to surface the error.
        throw err;
      }
      throw err;
    }
  };

  const logout = async () => {
    await signOut(auth);
  };

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signInWithGoogle, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
