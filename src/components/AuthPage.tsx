// ============================================
// Zule AI — Authentication Page (Glassmorphism Design)
// ============================================

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Loader2, Shield, Zap, Sparkles, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../firebase/AuthContext';
import { isElectron } from '../hooks/useElectronBridge';
import { sendPasswordResetEmail, signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { auth } from '../firebase/config';
import './AuthPage.css';

export function AuthPage() {
  const { signIn, signUp, signInWithGoogle } = useAuth();
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'email' | 'password'>('email');
  const [showLogin, setShowLogin] = useState(false);

  // Desktop Deep-Link Login State
  const [desktopLoginState, setDesktopLoginState] = useState<{ port: string; state: string } | null>(null);

  // Check URL params on mount
  useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('desktop_login') === 'true') {
      setDesktopLoginState({
        port: params.get('port') || '',
        state: params.get('state') || '',
      });
      setShowLogin(true); // Skip welcome splash
    }
  });

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
      if (desktopLoginState) {
        // We are the middleman browser for the Desktop app!
        const provider = new GoogleAuthProvider();
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (!credential || !credential.idToken) {
          throw new Error('Failed to retrieve Google ID Token');
        }

        // Post the token back to the waiting Electron local server
        const response = await fetch(`http://127.0.0.1:${desktopLoginState.port}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken: credential.idToken,
            state: desktopLoginState.state
          })
        });

        if (!response.ok) {
          throw new Error('Failed to hand off token to the Zule Desktop App. Try again.');
        }

        setSuccess('Authentication successful! You can safely close this tab and return to the Zule app.');
      } else {
        // Normal web app or Desktop app calling its own native bridge
        await signInWithGoogle();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Google sign-in failed';
      if (!message.includes('popup-closed-by-user')) {
        setError(message || 'Google sign-in failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setError('Enter your email first, then click Forgot Password');
      return;
    }
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, email);
      setSuccess('Password reset email sent! Check your inbox.');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to send reset email';
      if (message.includes('auth/user-not-found')) {
        setError('No account found with this email');
      } else {
        setError('Failed to send reset email. Try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      {/* Animated background mesh */}
      <div className="auth-mesh-bg">
        <motion.div
          className="mesh-orb mesh-orb-1"
          animate={{ x: [0, 30, -20, 0], y: [0, -40, 20, 0], scale: [1, 1.2, 0.9, 1] }}
          transition={{ duration: 20, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="mesh-orb mesh-orb-2"
          animate={{ x: [0, -40, 30, 0], y: [0, 30, -30, 0], scale: [1, 0.8, 1.1, 1] }}
          transition={{ duration: 25, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="mesh-orb mesh-orb-3"
          animate={{ x: [0, 20, -30, 0], y: [0, -20, 40, 0], scale: [1, 1.1, 0.85, 1] }}
          transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>

      {/* Floating particles */}
      <div className="auth-particles">
        {[...Array(6)].map((_, i) => (
          <motion.div
            key={i}
            className="particle"
            initial={{ opacity: 0 }}
            animate={{
              opacity: [0, 0.6, 0],
              y: [-20, -80 - i * 20],
              x: [0, (i % 2 === 0 ? 15 : -15)],
            }}
            transition={{
              duration: 4 + i * 0.5,
              repeat: Infinity,
              delay: i * 0.8,
              ease: 'easeOut',
            }}
            style={{ left: `${15 + i * 14}%`, bottom: '20%' }}
          />
        ))}
      </div>

      <AnimatePresence mode="wait">
        {!showLogin ? (
          /* ===== PREMIUM WELCOME SPLASH ===== */
          <motion.div
            key="welcome"
            className="auth-welcome"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.95, filter: 'blur(10px)' }}
            transition={{ duration: 0.5 }}
          >
            {/* Animated logo with glow pulse */}
            <motion.div
              className="auth-welcome-logo"
              initial={{ scale: 0, rotate: -180 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.2 }}
            >
              <motion.div
                className="logo-glow-ring"
                animate={{ scale: [1, 1.3, 1], opacity: [0.3, 0.6, 0.3] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              />
              <img src="/favicon.svg" alt="Zule AI" />
            </motion.div>

            {/* Title with letter-by-letter reveal */}
            <motion.h1
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            >
              <span className="auth-title-gradient">Zule AI</span>
            </motion.h1>

            <motion.p
              className="auth-welcome-tagline"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.7, duration: 0.6 }}
            >
              The invisible AI that works alongside you
            </motion.p>

            {/* Feature cards with staggered entrance */}
            <motion.div className="auth-feature-grid">
              {[
                { icon: <Shield size={20} />, title: 'Stealth Mode', desc: 'Invisible to screen share & recording' },
                { icon: <Zap size={20} />, title: 'Real-time AI', desc: 'Instant answers during live calls' },
                { icon: <Sparkles size={20} />, title: 'Multi-Provider', desc: 'Gemini, GPT, Claude, Ollama' },
              ].map((feature, i) => (
                <motion.div
                  key={i}
                  className="auth-feature-card"
                  initial={{ opacity: 0, y: 30, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ delay: 0.9 + i * 0.15, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                >
                  <div className="feature-card-icon">{feature.icon}</div>
                  <div className="feature-card-text">
                    <strong>{feature.title}</strong>
                    <span>{feature.desc}</span>
                  </div>
                </motion.div>
              ))}
            </motion.div>

            {/* CTA button with shimmer effect */}
            <motion.button
              className="auth-continue-btn"
              onClick={() => setShowLogin(true)}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.4, duration: 0.5 }}
              whileHover={{ scale: 1.03, boxShadow: '0 8px 40px rgba(20, 184, 166, 0.5)' }}
              whileTap={{ scale: 0.97 }}
            >
              <span className="btn-shimmer" />
              Get Started
              <ArrowRight size={18} />
            </motion.button>

            <motion.p
              className="auth-welcome-note"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.7 }}
            >
              Free to use • No credit card required
            </motion.p>
          </motion.div>
        ) : (
          /* ===== LOGIN / SIGNUP CARD ===== */
          <motion.div
            key="login"
            className="auth-card"
            initial={{ opacity: 0, y: 40, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="auth-card-glow" />

            <div className="auth-card-content">
              <motion.h1
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
              >
                {desktopLoginState ? 'Zule Desktop Login' : (isSignUp ? 'Create account' : 'Welcome back')}
              </motion.h1>
              <motion.p
                className="auth-subtitle"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
              >
                {desktopLoginState 
                  ? 'Sign in to authenticate the desktop app'
                  : (isSignUp ? 'Sign up to get started' : 'Sign in to your account')}
              </motion.p>

              <AnimatePresence mode="wait">
                {desktopLoginState && success ? (
                  <motion.div
                    key="desktop-success"
                    className="auth-success"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    style={{ textAlign: 'center', padding: '2rem', marginTop: '2rem' }}
                  >
                    <motion.div 
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ delay: 0.1, type: 'spring', stiffness: 200, damping: 15 }}
                      style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'center' }}
                    >
                      <motion.div
                        animate={{ boxShadow: ['0 0 0px 0px rgba(16, 185, 129, 0)', '0 0 40px 10px rgba(16, 185, 129, 0.3)', '0 0 0px 0px rgba(16, 185, 129, 0)'] }}
                        transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
                        style={{ borderRadius: '50%', display: 'flex', background: 'rgba(16, 185, 129, 0.1)', padding: '1rem' }}
                      >
                        <CheckCircle2 size={48} color="#10b981" strokeWidth={1.5} />
                      </motion.div>
                    </motion.div>
                    <h2 style={{ color: 'white', marginBottom: '0.75rem', fontWeight: 600, letterSpacing: '-0.5px' }}>Authentication complete</h2>
                    <p style={{ color: '#94a3b8', fontSize: '0.95rem', lineHeight: '1.5' }}>
                      You have successfully authenticated. You can safely close this tab and return to the Zule desktop app.
                    </p>
                  </motion.div>
                ) : desktopLoginState ? (
                  <motion.div
                    key="desktop-login"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    style={{ marginTop: '2rem' }}
                  >
                    {/* Render only Google button for desktop handoff */}
                  </motion.div>
                ) : step === 'email' ? (
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
                        type={showPassword ? 'text' : 'password'}
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        minLength={6}
                        autoComplete={isSignUp ? 'new-password' : 'current-password'}
                        autoFocus
                      />
                      <button
                        type="button"
                        className="auth-eye-toggle"
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                      <button type="submit" className="auth-input-arrow" disabled={loading} aria-label="Sign in">
                        {loading ? <Loader2 size={18} className="spinner" /> : <ArrowRight size={18} />}
                      </button>
                    </div>
                    {!isSignUp && (
                      <button type="button" className="auth-forgot-btn" onClick={handleForgotPassword}>
                        Forgot password?
                      </button>
                    )}
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

              {success && !desktopLoginState && (
                <motion.div
                  className="auth-success"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                >
                  {success}
                </motion.div>
              )}

              {/* Google sign-in works seamlessly via deep-link! */}
              {!success && (
                <>
                  {!desktopLoginState && (
                    <div className="auth-divider">
                      <span>OR</span>
                    </div>
                  )}

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
                </>
              )}

              {!desktopLoginState && (
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
              )}

              {!desktopLoginState && (
                <button className="auth-back-btn" onClick={() => setShowLogin(false)}>
                  ← Back
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
