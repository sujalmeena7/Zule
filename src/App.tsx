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

  // Sync offline state to the AI provider router (Requirement 20.1)
  useEffect(() => {
    setRouterOffline(!isOnline);
  }, [isOnline]);

  if (currentPage === 'landing') {
    return <LandingPage />;
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
  );
}

export default App;
