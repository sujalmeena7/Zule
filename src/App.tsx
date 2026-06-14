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
import { DetachedCopilot } from './components/copilot/DetachedCopilot';
import { LandingPage } from './components/LandingPage';
import { AuthPage } from './components/AuthPage';
import { AuthProvider, useAuth } from './firebase/AuthContext';
import { ModelLoader } from './components/common/ModelLoader';
import { LayoutDashboard, Settings as SettingsIcon, Activity } from 'lucide-react';
import { Toaster } from 'react-hot-toast';
import { MotionConfig } from 'framer-motion';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { OfflineBanner } from './components/OfflineBanner';
import { setRouterOffline } from './brain/aiProvider';
import { isElectron } from './hooks/useElectronBridge';
// Wrapper for the Electron Overlay that strips the opaque background
function OverlayShell() {
  useEffect(() => {
    // Force body and html to be transparent for the overlay window
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    
    return () => {
      document.documentElement.style.backgroundColor = '';
      document.body.style.backgroundColor = '';
    };
  }, []);

  return (
    <div className="electron-overlay-root">
      <ErrorBoundary>
        <FloatingCopilot />
      </ErrorBoundary>
    </div>
  );
}

function AppContent() {
  const { state } = useZule();
  const { currentPage, isCopilotActive } = state;
  const { isOnline } = useOnlineStatus();
  const { user, loading, logout } = useAuth();

  // Sync offline state to the AI provider router (Requirement 20.1)
  useEffect(() => {
    setRouterOffline(!isOnline);
  }, [isOnline]);

  // Show loading spinner while checking auth state
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0a12' }}>
        <div style={{ color: '#94a3b8', fontSize: '0.9rem' }}>Loading...</div>
      </div>
    );
  }

  if (currentPage === 'landing') {
    return <LandingPage />;
  }

  // Auth guard: if not logged in and not on landing, show auth page
  if (!user) {
    return <AuthPage />;
  }

  return (
    <div className="app-container">
      {/* Side Navigation */}
      <nav className="side-nav">
        <div className="nav-logo">
          <div className="logo-icon" />
          <span>Zule AI</span>
        </div>
        
        <div className="nav-links">
          <a href="#dashboard" className={`nav-link ${currentPage === 'dashboard' ? 'active' : ''}`}>
            <LayoutDashboard size={18} />
            Dashboard
          </a>
          <a href="#settings" className={`nav-link ${currentPage === 'settings' ? 'active' : ''}`}>
            <SettingsIcon size={18} />
            Settings
          </a>
          <a href="#diagnostics" className={`nav-link ${currentPage === 'diagnostics' ? 'active' : ''}`}>
            <Activity size={18} />
            Diagnostics
          </a>
        </div>

        {/* User Profile */}
        {user && (
          <div className="nav-profile">
            <div className="nav-profile-info">
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="nav-profile-avatar" referrerPolicy="no-referrer" />
              ) : (
                <div className="nav-profile-avatar nav-profile-avatar-fallback">
                  {(user.displayName || user.email || '?')[0].toUpperCase()}
                </div>
              )}
              <div className="nav-profile-details">
                <span className="nav-profile-name">{user.displayName || 'User'}</span>
                <span className="nav-profile-email">{user.email}</span>
              </div>
            </div>
            <button className="nav-logout-btn" onClick={() => logout()} title="Sign out">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
          {currentPage === 'dashboard' && <Dashboard />}
          {currentPage === 'settings' && <Settings />}
          {currentPage === 'diagnostics' && <DiagnosticsPanel />}
          {currentPage === 'meeting-detail' && state.selectedMeeting && (
            <MeetingDetail />
          )}
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
  // in a transparent container (no dashboard, no sidebar)
  if (hashRoute === '#overlay') {
    return (
      <ZuleProvider>
        <MotionConfig reducedMotion="user">
          <OverlayShell />
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: '#1e293b',
                color: '#f8fafc',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(10px)',
              },
            }}
          />
        </MotionConfig>
      </ZuleProvider>
    );
  }

  return (
    <AuthProvider>
      <ZuleProvider>
        <MotionConfig reducedMotion="user">
          <AppContent />
          <ModelLoader />
          <Toaster 
            position="bottom-right"
            toastOptions={{
              style: {
                background: '#1e293b',
                color: '#f8fafc',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                backdropFilter: 'blur(10px)',
              },
            }}
          />
        </MotionConfig>
      </ZuleProvider>
    </AuthProvider>
  );
}

export default App;
