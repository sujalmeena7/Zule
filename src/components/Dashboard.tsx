// ============================================
// Zule AI — Premium Dashboard
// ============================================

import {
  Play, Clock, Sparkles, Mic, Code, Briefcase, Target,
  ShoppingCart, Trash2, BarChart3, FileText, ChevronRight, Wand2
} from 'lucide-react';
import { useMemo } from 'react';
import { MODE_CONFIGS, type CopilotMode } from '../brain/modePrompts';
import { formatDuration, formatRelativeTime } from '../utils/formatters';
import { useAutoUpdate } from '../hooks/useAutoUpdate';
import { UpdateBanner } from './UpdateBanner';

import './Dashboard.css';

import { useZule } from '../context/ZuleContext';

const TEMPLATE_CARDS: { mode: CopilotMode; icon: React.ReactNode; gradient: string }[] = [
  { mode: 'assist', icon: <Sparkles size={22} />, gradient: 'linear-gradient(135deg, #3b82f6, #8b5cf6)' },
  { mode: 'coding-interview', icon: <Code size={22} />, gradient: 'linear-gradient(135deg, #22c55e, #14b8a6)' },
  { mode: 'behavioral-interview', icon: <Target size={22} />, gradient: 'linear-gradient(135deg, #f59e0b, #ef4444)' },
  { mode: 'sales-call', icon: <ShoppingCart size={22} />, gradient: 'linear-gradient(135deg, #ec4899, #f43f5e)' },
  { mode: 'what-should-i-say', icon: <Mic size={22} />, gradient: 'linear-gradient(135deg, #6366f1, #8b5cf6)' },
];

export function Dashboard() {
  const { state, actions } = useZule();
  const { meetings, customModes } = state;
  const { startCopilot, viewMeeting, deleteMeeting } = actions;

  const { state: updateState, dismissed, download, cancel, install, defer, dismiss } = useAutoUpdate();

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

  const recentMeetings = useMemo(() => [...meetings].reverse(), [meetings]);

  return (
    <div className="dashboard">
      {/* Update Banner — renders in normal flow, pushes content down (Req 4.10) */}
      <UpdateBanner
        state={updateState}
        dismissed={dismissed}
        onDownload={download}
        onCancel={cancel}
        onInstall={install}
        onDefer={defer}
        onDismiss={dismiss}
      />

      {/* Hero Section */}
      <section className="dash-hero">
        <div className="hero-content">
          <h1 className="hero-title">
            Your AI Meeting <span className="gradient-text">Copilot</span>
          </h1>
          <p className="hero-subtitle">
            Real-time suggestions, live transcription, and smart coaching — all completely invisible to your audience.
          </p>
          <button className="primary-btn" onClick={() => startCopilot()}>
            <Play size={18} fill="currentColor" />
            Start Session
          </button>
        </div>
        <div className="hero-visual">
          <div className="hero-orb orb-1" />
          <div className="hero-orb orb-2" />
          <div className="hero-orb orb-3" />
        </div>
      </section>

      {/* Bento Grid Layout */}
      <div className="bento-grid">
        
        {/* Stats Row */}
        <div className="bento-card bento-stats">
          <div className="stat-item">
            <div className="stat-icon-wrapper" style={{ color: '#3b82f6' }}>
              <Briefcase size={22} />
            </div>
            <div className="stat-content">
              <span className="stat-value">{stats.totalMeetings}</span>
              <span className="stat-label">Total Sessions</span>
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-icon-wrapper" style={{ color: '#8b5cf6' }}>
              <Clock size={22} />
            </div>
            <div className="stat-content">
              <span className="stat-value">{formatDuration(stats.totalTime)}</span>
              <span className="stat-label">Time Tracked</span>
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-icon-wrapper" style={{ color: '#22c55e' }}>
              <Sparkles size={22} />
            </div>
            <div className="stat-content">
              <span className="stat-value">{stats.totalSuggestions}</span>
              <span className="stat-label">AI Suggestions</span>
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-icon-wrapper" style={{ color: '#eab308' }}>
              <BarChart3 size={22} />
            </div>
            <div className="stat-content">
              <span className="stat-value">{stats.avgConfidence}</span>
              <span className="stat-label">Avg Confidence</span>
            </div>
          </div>
        </div>

        {/* Recent Sessions */}
        <div className="bento-card bento-recent">
          <div className="bento-header">
            <h2 className="bento-title">
              <FileText size={18} />
              Recent Sessions
            </h2>
          </div>
          
          {meetings.length === 0 ? (
            <div className="empty-state">
              <Sparkles size={48} />
              <h3>No sessions yet</h3>
              <p>Start a new session to see your transcripts and AI insights here.</p>
            </div>
          ) : (
            <div className="meeting-list">
              {recentMeetings.map(meeting => (
                <div key={meeting.id} className="meeting-card" onClick={() => viewMeeting(meeting)}>
                  <div className="meeting-info">
                    <span className="meeting-title">{meeting.title}</span>
                    <div className="meeting-meta">
                      <span><Clock size={12} /> {formatRelativeTime(meeting.startedAt)}</span>
                      <span>•</span>
                      <span>{formatDuration(meeting.duration)}</span>
                      <span>•</span>
                      <span style={{ color: 'var(--accent-blue)' }}>
                        <Sparkles size={12} /> {meeting.aiSuggestionCount}
                      </span>
                    </div>
                  </div>
                  <div className="meeting-actions">
                    <button 
                      className="btn-icon" 
                      title="View Details"
                    >
                      <ChevronRight size={16} />
                    </button>
                    <button 
                      className="btn-icon danger" 
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteMeeting(meeting.id);
                      }}
                      title="Delete Session"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick Start Templates */}
        <div className="bento-card bento-templates">
          <div className="bento-header">
            <h2 className="bento-title">
              <Target size={18} />
              Quick Start
            </h2>
          </div>
          <div className="template-list">
            {customModes.map((mode) => (
              <div 
                key={mode.id} 
                className="template-card"
                onClick={() => startCopilot(mode.id)}
              >
                <div className="template-icon" style={{ background: 'linear-gradient(135deg, #a855f7, #ec4899)' }}>
                  <Wand2 size={22} color="white" />
                </div>
                <div className="template-info">
                  <span className="template-name">{mode.label}</span>
                  <span className="template-desc">{mode.description}</span>
                </div>
                <ChevronRight size={16} color="var(--text-tertiary)" />
              </div>
            ))}

            {TEMPLATE_CARDS.map(({ mode, icon, gradient }) => {
              const config = MODE_CONFIGS[mode];
              return (
                <div 
                  key={mode} 
                  className="template-card"
                  onClick={() => startCopilot(mode)}
                >
                  <div className="template-icon" style={{ background: gradient }}>
                    {icon}
                  </div>
                  <div className="template-info">
                    <span className="template-name">{config.label}</span>
                    <span className="template-desc">{config.description}</span>
                  </div>
                  <ChevronRight size={16} color="var(--text-tertiary)" />
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}
