// ============================================
// Zule AI — Modern Minimal Dashboard
// Clean, Classy & Cluely-Inspired
// ============================================

import {
  Play, Clock, Sparkles, Mic, Code, Briefcase, Target,
  ShoppingCart, BarChart3, FileText, ChevronRight, Wand2, Zap,
  Lock, Trash2, Shield
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { MODE_CONFIGS, type CopilotMode } from '../brain/modePrompts';
import { formatDuration, formatRelativeTime } from '../utils/formatters';
import { useSubscription } from '../context/SubscriptionContext';
import { UpgradeModal } from './UpgradeModal';
import type { GatedFeature } from '../types/subscription';
import { useZule } from '../context/ZuleContext';

import './Dashboard.css';

const TEMPLATE_CARDS: { mode: CopilotMode; icon: React.ReactNode; colorClass: string }[] = [
  { mode: 'assist',               icon: <Sparkles size={15} />,     colorClass: 'blue' },
  { mode: 'coding-interview',     icon: <Code size={15} />,         colorClass: 'green' },
  { mode: 'behavioral-interview', icon: <Target size={15} />,       colorClass: 'amber' },
  { mode: 'sales-call',           icon: <ShoppingCart size={15} />, colorClass: 'rose' },
  { mode: 'what-should-i-say',   icon: <Mic size={15} />,          colorClass: 'purple' },
];

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export function Dashboard() {
  const { state, actions } = useZule();
  const { meetings, customModes } = state;
  const { startCopilot, viewMeeting, deleteMeeting } = actions;

  const { isFeatureAvailable, isLimitReached, incrementUsage, limits } = useSubscription();

  const [upgradeModal, setUpgradeModal] = useState<{
    reason: 'meeting-limit' | 'feature-locked';
    feature?: GatedFeature;
  } | null>(null);

  const handleStartSession = (mode?: string) => {
    if (isLimitReached('meetingsPerDay')) {
      setUpgradeModal({ reason: 'meeting-limit' });
      return;
    }

    if (mode) {
      if (TEMPLATE_CARDS.some(c => c.mode === mode)) {
        const feature = `copilot.mode.${mode}` as GatedFeature;
        if (!isFeatureAvailable(feature)) {
          setUpgradeModal({ reason: 'feature-locked', feature });
          return;
        }
      } else {
        if (!isFeatureAvailable('copilot.custom-modes')) {
          setUpgradeModal({ reason: 'feature-locked', feature: 'copilot.custom-modes' });
          return;
        }
      }
    }

    incrementUsage('meetingCount');
    startCopilot(mode);
  };

  const stats = useMemo(() => {
    let totalTime = 0, totalSuggestions = 0, totalConfidence = 0;
    for (const m of meetings) {
      totalTime += m.duration;
      totalSuggestions += m.aiSuggestionCount;
      totalConfidence += m.avgConfidence;
    }
    return {
      totalMeetings: meetings.length,
      totalTime,
      totalSuggestions,
      avgConfidence: meetings.length > 0 ? Math.round(totalConfidence / meetings.length) : 0,
    };
  }, [meetings]);

  const recentMeetings = useMemo(() => {
    const cutoff = Date.now() - (limits.historyRetentionDays * 24 * 60 * 60 * 1000);
    return [...meetings]
      .filter(m => m.startedAt >= cutoff)
      .reverse();
  }, [meetings, limits.historyRetentionDays]);

  return (
    <div className="dashboard">
      {upgradeModal && (
        <UpgradeModal
          reason={upgradeModal.reason}
          feature={upgradeModal.feature}
          onClose={() => setUpgradeModal(null)}
        />
      )}


      {/* ── Top Header ── */}
      <div className="dash-top-bar">
        <div className="dash-greeting-wrap">
          <h1 className="dash-greeting-text">
            {getGreeting()}
          </h1>
        </div>

        <div className="dash-status-pill">
          <span className="status-indicator-dot" />
          <span>Stealth Active</span>
        </div>
      </div>

      {/* ── Modern Minimal Hero Card ── */}
      <section className="dash-hero">
        <div className="hero-glow-layer" />
        <div className="hero-content">
          <h2 className="hero-title">
            Your AI Meeting Copilot
          </h2>
          <p className="hero-subtitle">
            Real-time suggestions, live transcription, and smart coaching — completely invisible to your audience.
          </p>

          <div className="hero-actions">
            <button
              className="hero-primary-btn"
              onClick={() => handleStartSession()}
            >
              <Play size={15} fill="currentColor" />
              <span>Start Session</span>
            </button>

            <button
              className="hero-secondary-btn"
              onClick={() => handleStartSession('assist')}
            >
              <Zap size={14} />
              <span>Quick Assist</span>
            </button>
          </div>
        </div>
      </section>

      {/* ── Stats Row ── */}
      <div className="dash-stats-row">
        <div className="stat-box">
          <div className="stat-icon blue">
            <Briefcase size={16} />
          </div>
          <div className="stat-meta">
            <span className="stat-val">{stats.totalMeetings}</span>
            <span className="stat-lbl">Total Sessions</span>
          </div>
        </div>

        <div className="stat-box">
          <div className="stat-icon purple">
            <Clock size={16} />
          </div>
          <div className="stat-meta">
            <span className="stat-val">{formatDuration(stats.totalTime)}</span>
            <span className="stat-lbl">Time Guided</span>
          </div>
        </div>

        <div className="stat-box">
          <div className="stat-icon green">
            <Sparkles size={16} />
          </div>
          <div className="stat-meta">
            <span className="stat-val">{stats.totalSuggestions}</span>
            <span className="stat-lbl">AI Suggestions</span>
          </div>
        </div>

        <div className="stat-box">
          <div className="stat-icon amber">
            <BarChart3 size={16} />
          </div>
          <div className="stat-meta">
            <span className="stat-val">{stats.avgConfidence}%</span>
            <span className="stat-lbl">Avg Confidence</span>
          </div>
        </div>
      </div>

      {/* ── Main 2-Column Grid ── */}
      <div className="dash-main-layout">

        {/* Recent Sessions */}
        <div className="dash-card sessions-card">
          <div className="dash-card-header">
            <div className="dash-card-title">
              <FileText size={15} />
              <h3>Recent Sessions</h3>
            </div>
            <span className="dash-badge">{recentMeetings.length}</span>
          </div>

          {recentMeetings.length === 0 ? (
            <div className="dash-empty">
              <Sparkles size={22} className="empty-icon" />
              <h4>No sessions yet</h4>
              <p>Start a session to see your transcripts and AI insights here.</p>
            </div>
          ) : (
            <div className="sessions-list">
              {recentMeetings.map(meeting => (
                <div
                  key={meeting.id}
                  className="session-row"
                  onClick={() => viewMeeting(meeting)}
                >
                  <div className="session-row-left">
                    <span className="session-row-title">{meeting.title}</span>
                    <div className="session-row-meta">
                      <span><Clock size={11} /> {formatRelativeTime(meeting.startedAt)}</span>
                      <span>•</span>
                      <span>{formatDuration(meeting.duration)}</span>
                      <span>•</span>
                      <span className="meta-suggestion-tag"><Sparkles size={11} /> {meeting.aiSuggestionCount}</span>
                    </div>
                  </div>

                  <div className="session-row-actions">
                    <button className="row-action-btn" title="View details">
                      <ChevronRight size={14} />
                    </button>
                    <button
                      className="row-action-btn delete"
                      title="Delete session"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteMeeting(meeting.id);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick Start Modes */}
        <div className="dash-card quickstart-card">
          <div className="dash-card-header">
            <div className="dash-card-title">
              <Target size={15} />
              <h3>Quick Start</h3>
            </div>
          </div>

          <div className="quickstart-list">
            {customModes.map((mode) => {
              const isLocked = !isFeatureAvailable('copilot.custom-modes');
              return (
                <div
                  key={mode.id}
                  className={`quickstart-item ${isLocked ? 'locked' : ''}`}
                  onClick={() => handleStartSession(mode.id)}
                >
                  <div className="quickstart-icon custom">
                    <Wand2 size={15} />
                  </div>
                  <div className="quickstart-info">
                    <span className="quickstart-name">
                      {mode.label}
                      {isLocked && <Lock size={11} />}
                    </span>
                    <span className="quickstart-desc">{mode.description}</span>
                  </div>
                  <ChevronRight size={14} className="quickstart-arrow" />
                </div>
              );
            })}

            {TEMPLATE_CARDS.map(({ mode, icon, colorClass }) => {
              const config = MODE_CONFIGS[mode];
              const feature = `copilot.mode.${mode}` as GatedFeature;
              const isLocked = !isFeatureAvailable(feature);

              return (
                <div
                  key={mode}
                  className={`quickstart-item ${isLocked ? 'locked' : ''}`}
                  onClick={() => handleStartSession(mode)}
                >
                  <div className={`quickstart-icon ${colorClass}`}>
                    {icon}
                  </div>
                  <div className="quickstart-info">
                    <span className="quickstart-name">
                      {config.label}
                      {isLocked && <Lock size={11} />}
                    </span>
                    <span className="quickstart-desc">{config.description}</span>
                  </div>
                  <ChevronRight size={14} className="quickstart-arrow" />
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}

