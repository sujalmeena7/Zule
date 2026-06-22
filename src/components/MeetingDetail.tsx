// ============================================
// Zule AI — Meeting Detail
// ============================================

import { useState, useCallback } from 'react';
import {
  ArrowLeft, Clock, Sparkles, MessageSquare, CheckSquare,
  Square, BarChart3, Mail, Copy, Check, RefreshCw
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDuration, formatDate, formatTimestamp } from '../utils/formatters';
import { database as storage } from '../data/database';
import { retrySummary } from '../brain/stopSession';
import { MODE_CONFIGS, type CopilotMode } from '../brain/modePrompts';
import './MeetingDetail.css';
import { useZule } from '../context/ZuleContext';
import toast from 'react-hot-toast';

export function MeetingDetail() {
  const { state, actions } = useZule();
  const meeting = state.selectedMeeting!; // We only render this when selectedMeeting exists
  const onBack = () => actions.navigateTo('dashboard');

  const [activeTab, setActiveTab] = useState<'transcript' | 'summary' | 'actions' | 'analytics' | 'followup'>('summary');
  const [actionItems, setActionItems] = useState(meeting.actionItems);
  const [copiedSection, setCopiedSection] = useState<'summary' | 'transcript' | 'email' | null>(null);
  const [isRetryingSummary, setIsRetryingSummary] = useState(false);
  const [currentMeeting, setCurrentMeeting] = useState(meeting);

  const toggleAction = useCallback((id: string) => {
    setActionItems(prev => {
      const updated = prev.map(item =>
        item.id === id ? { ...item, completed: !item.completed } : item
      );
      // Persist updated action items to IndexedDB using currentMeeting (not stale meeting)
      storage.saveMeeting({ ...currentMeeting, actionItems: updated });
      return updated;
    });
  }, [currentMeeting]);

  const handleRetrySummary = useCallback(async () => {
    if (isRetryingSummary) return;
    setIsRetryingSummary(true);
    try {
      const result = await retrySummary(currentMeeting.id, state.apiKey);
      setCurrentMeeting(result.meeting);
      if (result.success) {
        setActionItems(result.meeting.actionItems);
      }
      // Refresh ZuleContext.selectedMeeting so it reflects the retried result
      storage.getMeeting(currentMeeting.id).then((refreshed) => {
        if (refreshed) actions.viewMeeting(refreshed);
      });
    } catch (error) {
      toast.error('Failed to regenerate summary. Please try again.');
    } finally {
      setIsRetryingSummary(false);
    }
  }, [currentMeeting.id, state.apiKey, isRetryingSummary, actions]);

  const getEmailContent = () => {
    if (meeting.followUpEmail && meeting.followUpEmail !== 'Follow-up email could not be generated.') {
      return meeting.followUpEmail;
    }
    const transcriptSummary = meeting.transcript.slice(0, 5).map(l => l.text).join('. ');
    return `Hi Team,

Thank you for the productive session today (${formatDate(meeting.startedAt)}, ${formatDuration(meeting.duration)}).

Here's a quick recap:
${meeting.summary}

Key discussion points from our conversation included topics around: ${transcriptSummary}...

Please let me know if I missed anything or if you have any follow-up items.

Best regards`;
  };

  const handleCopy = (text: string, section: 'summary' | 'transcript' | 'email') => {
    navigator.clipboard.writeText(text);
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  const modeConfig = MODE_CONFIGS[meeting.mode as CopilotMode];

  return (
    <div className="meeting-detail page-container">
      {/* Header */}
      <div className="detail-header animate-slide-up">
        <button className="btn-secondary" onClick={onBack}>
          <ArrowLeft size={16} />
          Back
        </button>
        <div className="detail-title-area">
          <div className="detail-mode-icon">{modeConfig?.icon || '✦'}</div>
          <div>
            <h1 className="detail-title">{meeting.title}</h1>
            <p className="detail-meta">
              {formatDate(meeting.startedAt)} • {formatDuration(meeting.duration)} • {meeting.aiSuggestionCount} AI suggestions
            </p>
          </div>
        </div>
      </div>

      {/* Stats Strip */}
      <div className="detail-stats animate-slide-up" style={{ animationDelay: '0.1s' }}>
        <div className="detail-stat">
          <Clock size={14} />
          <span>{formatDuration(meeting.duration)}</span>
        </div>
        <div className="detail-stat">
          <Sparkles size={14} />
          <span>{meeting.aiSuggestionCount} suggestions</span>
        </div>
        <div className="detail-stat">
          <MessageSquare size={14} />
          <span>{meeting.transcript.length} lines</span>
        </div>
        <div className="detail-stat">
          <BarChart3 size={14} />
          <span>Confidence: {meeting.avgConfidence}/100</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="detail-tabs animate-slide-up" style={{ animationDelay: '0.15s' }}>
        {(['summary', 'transcript', 'actions', 'analytics', 'followup'] as const).map(tab => (
          <button
            key={tab}
            className={`detail-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'summary' && 'Summary'}
            {tab === 'transcript' && 'Transcript'}
            {tab === 'actions' && 'Action Items'}
            {tab === 'analytics' && 'Analytics'}
            {tab === 'followup' && 'Follow-up Email'}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="detail-content animate-slide-up" style={{ animationDelay: '0.2s' }}>
        {activeTab === 'summary' && (
          <div className="content-section glass-card">
            <div className="content-header">
              <h3>Meeting Summary</h3>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {(currentMeeting.aiSummaryStatus === 'failed' || currentMeeting.aiSummaryStatus === 'pending') && (
                  <button
                    className="btn-primary"
                    onClick={handleRetrySummary}
                    disabled={isRetryingSummary}
                    style={{ padding: '6px 14px', fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: '6px' }}
                    aria-label="Retry summary generation"
                  >
                    <RefreshCw size={14} className={isRetryingSummary ? 'spin' : ''} />
                    {isRetryingSummary ? 'Generating...' : 'Retry Summary'}
                  </button>
                )}
                <button
                  className="btn-icon"
                  onClick={() => handleCopy(currentMeeting.summary, 'summary')}
                  title="Copy summary"
                >
                  {copiedSection === 'summary' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            <div className="summary-text markdown-content">
              {currentMeeting.aiSummaryStatus === 'pending' && (
                <p style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  Summary generation is pending...
                </p>
              )}
              {currentMeeting.aiSummaryStatus === 'failed' && (
                <p style={{ color: 'var(--error-color, #ef4444)', marginBottom: '12px' }}>
                  Summary generation failed. Click "Retry Summary" to try again.
                </p>
              )}
              {currentMeeting.summary ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {currentMeeting.summary}
                </ReactMarkdown>
              ) : (
                currentMeeting.aiSummaryStatus !== 'pending' && currentMeeting.aiSummaryStatus !== 'failed' && (
                  'No summary was generated for this session. Try speaking more during your next session for a detailed recap.'
                )
              )}
            </div>
          </div>
        )}

        {activeTab === 'transcript' && (
          <div className="content-section glass-card">
            <div className="content-header">
              <h3>Full Transcript</h3>
              <button
                className="btn-icon"
                onClick={() => handleCopy(meeting.transcript.map(l => `[${l.speaker}] ${l.text}`).join('\n'), 'transcript')}
              >
                {copiedSection === 'transcript' ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <div className="transcript-list">
              {meeting.transcript.length === 0 ? (
                <p className="empty-text">No transcript recorded.</p>
              ) : (
                meeting.transcript.map(line => (
                  <div key={line.id} className="transcript-entry">
                    <span className="transcript-time">{formatTimestamp(line.timestamp)}</span>
                    <span className={`transcript-speaker ${line.speaker}`}>{line.speaker === 'user' ? 'You' : 'Other'}</span>
                    <span className="transcript-content">{line.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'actions' && (
          <div className="content-section glass-card">
            <h3>Action Items</h3>
            <div className="action-list">
              {actionItems.length === 0 ? (
                <p className="empty-text">No action items were captured. The AI will automatically detect action items in future sessions.</p>
              ) : (
                actionItems.map(item => (
                  <div
                    key={item.id}
                    className={`action-item ${item.completed ? 'completed' : ''}`}
                    onClick={() => toggleAction(item.id)}
                  >
                    {item.completed ? (
                      <CheckSquare size={16} className="action-check checked" />
                    ) : (
                      <Square size={16} className="action-check" />
                    )}
                    <span>{item.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'analytics' && (
          <div className="content-section glass-card">
            <h3>Session Analytics</h3>
            <div className="analytics-grid">
              <div className="analytic-card">
                <span className="analytic-label">Speaking Pace</span>
                <span className={`analytic-value ${meeting.wordsPerMinute > 180 ? 'bad' : meeting.wordsPerMinute < 90 ? 'warn' : 'good'}`}>
                  {meeting.wordsPerMinute} WPM
                </span>
                <span className="analytic-hint">
                  {meeting.wordsPerMinute > 180 ? 'Too fast — slow down' : meeting.wordsPerMinute < 90 ? 'Consider speaking faster' : 'Great pace!'}
                </span>
              </div>
              <div className="analytic-card">
                <span className="analytic-label">Filler Words</span>
                <span className={`analytic-value ${meeting.fillerCount > 15 ? 'bad' : meeting.fillerCount > 8 ? 'warn' : 'good'}`}>
                  {meeting.fillerCount}
                </span>
                <span className="analytic-hint">
                  {meeting.fillerCount > 15 ? 'Try to reduce filler words' : meeting.fillerCount > 8 ? 'Room for improvement' : 'Excellent clarity!'}
                </span>
              </div>
              <div className="analytic-card">
                <span className="analytic-label">Confidence Score</span>
                <span className={`analytic-value ${meeting.avgConfidence < 50 ? 'bad' : meeting.avgConfidence < 75 ? 'warn' : 'good'}`}>
                  {meeting.avgConfidence}/100
                </span>
                <span className="analytic-hint">
                  {meeting.avgConfidence < 50 ? 'Practice more!' : meeting.avgConfidence < 75 ? 'Good, keep improving' : 'Top performer!'}
                </span>
              </div>
              <div className="analytic-card">
                <span className="analytic-label">Total Words</span>
                <span className="analytic-value good">
                  {meeting.transcript.reduce((acc, l) => acc + l.text.split(/\s+/).length, 0)}
                </span>
                <span className="analytic-hint">Words spoken this session</span>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'followup' && (
          <div className="content-section glass-card">
            <div className="content-header">
              <h3>
                <Mail size={16} style={{ marginRight: 8 }} />
                Auto-Generated Follow-up Email
              </h3>
              <button
                className="btn-primary"
                onClick={() => handleCopy(getEmailContent(), 'email')}
                style={{ padding: '6px 14px', fontSize: '0.78rem' }}
              >
                {copiedSection === 'email' ? <Check size={14} /> : <Copy size={14} />}
                {copiedSection === 'email' ? 'Copied!' : 'Copy Email'}
              </button>
            </div>
            <div className="followup-email markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {getEmailContent()}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
