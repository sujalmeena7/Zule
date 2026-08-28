// ============================================
// Zule AI — Main Application
// ============================================

import { useState, useEffect } from 'react';
import './App.css';
import { Dashboard } from './components/Dashboard';
import { FloatingCopilot } from './components/FloatingCopilot';
import { MeetingDetail } from './components/MeetingDetail';
import { Settings } from './components/Settings';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { ZuleProvider, useZule } from './context/ZuleContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OverlayShell } from './components/OverlayShell';
import { DetachedCopilot } from './components/copilot/DetachedCopilot';
import { LandingPage } from './components/LandingPage';
import { AuthPage } from './components/AuthPage';
import { PrivacyPolicy } from './components/PrivacyPolicy';
import { TermsOfService } from './components/TermsOfService';
import { AuthProvider, useAuth } from './firebase/AuthContext';
import { SubscriptionProvider } from './context/SubscriptionContext';
import { ModelLoader } from './components/common/ModelLoader';
import { LayoutDashboard, Settings as SettingsIcon, Activity } from 'lucide-react';
import { Toaster } from 'react-hot-toast';
import { MotionConfig, AnimatePresence, motion } from 'framer-motion';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { OfflineBanner } from './components/OfflineBanner';
import { setRouterOffline } from './brain/aiProvider';
import { isElectron } from './hooks/useElectronBridge';
import { BlogPage } from './components/BlogPage';
import { BlogPost } from './components/BlogPost';
import { PricingPage } from './components/PricingPage';
import { SubscriptionBadge } from './components/SubscriptionBadge';
import { useIpcTelemetrySink } from './hooks/useIpcTelemetrySink';

function AppContent() {
  const { state } = useZule();
  const { currentPage, isCopilotActive } = state;
  const { isOnline } = useOnlineStatus();
  const { user, loading, logout } = useAuth();

  // Forward main-process telemetry events (auto-updater, vectorIndex) to
  // the renderer's TelemetryModule for IndexedDB persistence.
  // Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
  useIpcTelemetrySink();

  // Sync offline state to the AI provider router (Requirement 20.1)
  useEffect(() => {
    setRouterOffline(!isOnline);
  }, [isOnline]);

  // Vector_Index cold-start hydration (Requirements 3.1, 3.2). Runs once
  // per logged-in Electron session: pre-warms the embedding model, asks
  // the main process to load the persisted snapshot, and rebuilds from
  // IndexedDB only when the main process reports a corrupt-or-missing
  // snapshot. Fires before the user navigates to the Knowledge_Base
  // surface in Settings, so the ANN path in `database.search` is ready
  // for the first query.
  useEffect(() => {
    if (!user || !isElectron()) return;
    let cancelled = false;
    void import('./data/vectorIndexHydration').then(({ hydrateVectorIndexOnBoot }) => {
      if (cancelled) return;
      void hydrateVectorIndexOnBoot();
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Show loading spinner while checking auth state
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a12' }}>
        <div style={{ color: '#94a3b8', fontSize: '0.9rem' }}>Loading...</div>
      </div>
    );
  }

  // Check if this is a deep-link for desktop authentication
  const isDesktopLogin = new URLSearchParams(window.location.search).get('desktop_login') === 'true';

  // Force AuthPage for desktop login handoff, bypassing all other routes
  if (isDesktopLogin) {
    return <AuthPage />;
  }

  if (currentPage === 'landing') {
    return <LandingPage />;
  }

  if (currentPage === 'blog') {
    return <BlogPage />;
  }

  if (currentPage === 'blog-post') {
    return <BlogPost />;
  }

  // Web browser: only allow public marketing pages, block dashboard access
  if (!isElectron()) {
    return <LandingPage />;
  }

  // Auth guard: if not logged in and not on public pages, show auth page
  if (!user) {
    return <AuthPage />;
  }

  return (
    <div className="app-container">
      {/* Side Navigation */}
      <nav className="side-nav">
        <div className="nav-logo">
          <div className="logo-icon" />
          <div className="logo-text-wrap">
            <span className="logo-title">Zule AI</span>
            <span className="logo-badge">Stealth</span>
          </div>
        </div>

        <div className="nav-section">
          <span className="nav-section-title">Menu</span>
          <div className="nav-links">
            <a href="#dashboard" className={`nav-link ${currentPage === 'dashboard' ? 'active' : ''}`}>
              <LayoutDashboard size={16} />
              <span>Dashboard</span>
            </a>
            <a href="#settings" className={`nav-link ${currentPage === 'settings' ? 'active' : ''}`}>
              <SettingsIcon size={16} />
              <span>Settings</span>
            </a>
            <a href="#diagnostics" className={`nav-link ${currentPage === 'diagnostics' ? 'active' : ''}`}>
              <Activity size={16} />
              <span>Diagnostics</span>
            </a>
          </div>
        </div>

        {/* Subscription section */}
        <div className="nav-sub-wrap">
          <SubscriptionBadge />
        </div>

        {/* User Profile Capsule */}
        {user && (
          <div className="nav-profile">
            <div className="nav-profile-info">
              <div className="nav-avatar-wrap">
                {user.photoURL ? (
                  <img src={user.photoURL} alt="" className="nav-profile-avatar" referrerPolicy="no-referrer" />
                ) : (
                  <div className="nav-profile-avatar nav-profile-avatar-fallback">
                    {(user.displayName || user.email || '?')[0].toUpperCase()}
                  </div>
                )}
                <span className="nav-avatar-online" />
              </div>
              <div className="nav-profile-details">
                <span className="nav-profile-name">{user.displayName || 'User'}</span>
                <span className="nav-profile-email">{user.email}</span>
              </div>
            </div>
            <button className="nav-logout-btn" onClick={() => logout()} title="Sign out">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        )}
      </nav>


      {/* Main Content Area */}
      <main className="main-content">
        {/* Offline banner — non-blocking, shown above main content */}
        {!isOnline && <OfflineBanner />}
        <ErrorBoundary>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={currentPage}
              initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              style={{ width: '100%' }}
            >
              {currentPage === 'dashboard' && <Dashboard />}
              {currentPage === 'settings' && <Settings />}
              {currentPage === 'diagnostics' && <DiagnosticsPanel />}
              {currentPage === 'pricing' && <PricingPage />}
              {currentPage === 'meeting-detail' && state.selectedMeeting && (
                <MeetingDetail />
              )}
            </motion.div>
          </AnimatePresence>
        </ErrorBoundary>
      </main>


      {/* Floating Copilot Overlay — only render inline in web mode.
          In Electron, the copilot runs in its own separate transparent
          always-on-top window that floats above ALL desktop windows. */}
      {isCopilotActive && !isElectron() && (
        <ErrorBoundary>
          <FloatingCopilot />
        </ErrorBoundary>
      )}
    </div>
  );
}

function App() {
  const [hashRoute, setHashRoute] = useState(window.location.hash);

  useEffect(() => {
    const handleHash = () => setHashRoute(window.location.hash);
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  // Electron detached copilot window (legacy web mode)
  if (hashRoute === '#detached') {
    return (
      <ErrorBoundary>
        <DetachedCopilot />
      </ErrorBoundary>
    );
  }

  // Electron overlay window — renders ONLY the FloatingCopilot
  // in a transparent container (no dashboard, no sidebar).
  // OverlayShell provides its own Auth/Subscription/Zule providers
  // and MotionConfig/Toaster, since this branch mounts in isolation
  // (this route is actually intercepted earlier in main.tsx before
  // App ever mounts, but is kept here for web-mode/dev parity).
  if (hashRoute === '#overlay') {
    return <OverlayShell />;
  }

  // Legal and Main Pages wrapped in AnimatePresence for smooth transitions
  let currentView;
  if (hashRoute === '#privacy') {
    currentView = (
      <motion.div key="privacy" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} transition={{ duration: 0.3 }}>
        <ErrorBoundary>
          <PrivacyPolicy />
        </ErrorBoundary>
      </motion.div>
    );
  } else if (hashRoute === '#terms') {
    currentView = (
      <motion.div key="terms" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} transition={{ duration: 0.3 }}>
        <ErrorBoundary>
          <TermsOfService />
        </ErrorBoundary>
      </motion.div>
    );
  } else {
    currentView = (
      <motion.div key="main" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
        <AppContent />
      </motion.div>
    );
  }

  return (
    <AuthProvider>
      <SubscriptionProvider>
        <ZuleProvider>
          <MotionConfig reducedMotion="user">
            <AnimatePresence mode="wait">
              {currentView}
            </AnimatePresence>
            <ModelLoader />
            <Toaster
              position="bottom-right"
              toastOptions={{
                duration: 3000,
                style: {
                  background: '#0e0e14',
                  color: '#ffffff',
                  border: '1px solid #242432',
                  boxShadow: '0 12px 36px -4px rgba(0, 0, 0, 0.7)',
                  borderRadius: '12px',
                  fontSize: '0.84rem',
                  fontWeight: 500,
                  padding: '12px 16px',
                  letterSpacing: '-0.01em',
                  backdropFilter: 'blur(16px)',
                },
                success: {
                  iconTheme: {
                    primary: '#10b981',
                    secondary: '#0e0e14',
                  },
                },
                error: {
                  iconTheme: {
                    primary: '#ef4444',
                    secondary: '#0e0e14',
                  },
                },
              }}
            />

          </MotionConfig>
        </ZuleProvider>
      </SubscriptionProvider>
    </AuthProvider>
  );
}

export default App;
