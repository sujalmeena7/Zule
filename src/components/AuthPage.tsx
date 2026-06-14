// ============================================
// Zule AI — Authentication Page (Glassmorphism Design)
// ============================================

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Loader2 } from 'lucide-react';
import { useAuth } from '../firebase/AuthContext';
import './AuthPage.css';

export function AuthPage() {
  const { signIn, signUp, signInWithGoogle } = useAuth();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'email' | 'password'>('email');

  const handleEmailSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setError('');
    setStep('password');
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isSignUp) {
        await signUp(email, password);
      } else {
        await signIn(email, password);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      if (message.includes('auth/invalid-credential')) {
        setError('Invalid email or password');
      } else if (message.includes('auth/email-already-in-use')) {
        setError('Email already in use');
      } else if (message.includes('auth/weak-password')) {
        setError('Password must be at least 6 characters');
      } else if (message.includes('auth/invalid-email')) {
        setError('Invalid email address');
      } else {
        setError(message.replace('Firebase: ', '').replace(/\(auth\/.*\)/, '').trim());
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      await signInWithGoogle();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Google sign-in failed';
      if (!message.includes('popup-closed-by-user')) {
        setError('Google sign-in failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <motion.div
        className="auth-card"
        initial={{ opacity: 0, y: 30, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Top glow accent */}
        <div className="auth-card-glow" />

        <div className="auth-card-content">
          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            {isSignUp ? 'Create account' : 'Welcome back'}
          </motion.h1>
          <motion.p
            className="auth-subtitle"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            {isSignUp ? 'Sign up to get started' : 'Sign in to your account'}
          </motion.p>

          <AnimatePresence mode="wait">
            {step === 'email' ? (
              <motion.form
                key="email-step"
                className="auth-email-form"
                onSubmit={handleEmailSubmit}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ delay: 0.35 }}
              >
                <div className="auth-input-floating">
                  <label>Email</label>
                  <input
                    type="email"
                    placeholder="username@gmail.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    autoFocus
                  />
                  <button type="submit" className="auth-input-arrow" aria-label="Continue">
                    <ArrowRight size={18} />
                  </button>
                </div>
              </motion.form>
            ) : (
              <motion.form
                key="password-step"
                className="auth-password-form"
                onSubmit={handlePasswordSubmit}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <div className="auth-email-display">
                  <span>{email}</span>
                  <button type="button" className="auth-change-email" onClick={() => setStep('email')}>Change</button>
                </div>
                <div className="auth-input-floating">
                  <label>Password</label>
                  <input
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete={isSignUp ? 'new-password' : 'current-password'}
                    autoFocus
                  />
                  <button type="submit" className="auth-input-arrow" disabled={loading} aria-label="Sign in">
                    {loading ? <Loader2 size={18} className="spinner" /> : <ArrowRight size={18} />}
                  </button>
                </div>
              </motion.form>
            )}
          </AnimatePresence>

          {error && (
            <motion.div
              className="auth-error"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
            >
              {error}
            </motion.div>
          )}

          <div className="auth-divider">
            <span>OR</span>
          </div>

          <motion.button
            className="auth-social-btn"
            onClick={handleGoogleSignIn}
            disabled={loading}
            type="button"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45 }}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            <span>Continue with Google</span>
            <ArrowRight size={16} className="auth-social-arrow" />
          </motion.button>

          <motion.div
            className="auth-switch"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
          >
            {isSignUp ? (
              <p>Already have an account? <button onClick={() => { setIsSignUp(false); setError(''); setStep('email'); }}>Sign in</button></p>
            ) : (
              <p>Don't have an account? <button onClick={() => { setIsSignUp(true); setError(''); setStep('email'); }}>Sign up</button></p>
            )}
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
}
