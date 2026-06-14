// ============================================
// Zule AI — Floating Copilot (Exact Cluely UI)
// Decomposed into sub-components with bug fixes
// ============================================

import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { useTranscription } from '../hooks/useTranscription';
import { useScreenCapture } from '../hooks/useScreenCapture';
import { useDraggable } from '../hooks/useDraggable';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useCrossWindowSync } from '../hooks/useCrossWindowSync';
import { useElectronBridge } from '../hooks/useElectronBridge';
import { clampPosition } from '../utils/geometry';
import { speakerManager } from '../brain/speakerManager';
import { generateMeetingSummary } from '../brain/summaryEngine';
import { persistPlaceholderMeeting, generateSummaryWithTimeout } from '../brain/stopSession';
import { buildContextWindow } from '../brain/contextManager';
import type { TranscriptLine, CitationInfo } from '../brain/contextManager';
import type { TranscriptionLine } from '../types/transcription';
import { streamAIResponse } from '../brain/aiProvider';
import type { AIResponse } from '../brain/aiProvider';
import { activeAdapterSupportsImageInput } from '../brain/aiProvider';
import { database as knowledgeBase } from '../data/database';
import { QuestionDetectorStream } from '../brain/questionDetector';
import { getFullAnalysis } from '../brain/sentimentAnalyzer';
import { semanticCache } from '../brain/responseCache';
import type { SentimentResult } from '../brain/sentimentAnalyzer';
import { MODE_CONFIGS, type CopilotMode } from '../brain/modePrompts';
import { generateId } from '../utils/formatters';
import toast from 'react-hot-toast';

import { ControlCapsule } from './copilot/ControlCapsule';
import { SuggestionCard } from './copilot/SuggestionCard';
import { QuickActions } from './copilot/QuickActions';
import { InputBar } from './copilot/InputBar';
import { useOverlayMode } from '../overlay/useOverlayMode';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import './FloatingCopilot.css';

import { useZule } from '../context/ZuleContext';

/** Map new TranscriptionLine[] to legacy TranscriptLine[] for APIs still on the old type. */
function toLegacyTranscript(lines: TranscriptionLine[]): TranscriptLine[] {
  return lines.map(l => ({
    id: l.id,
    text: l.text,
    timestamp: l.timestamp,
    isInterim: l.isInterim,
    speaker: l.speakerRole,
  }));
}

/** Outward-arrow icon for the card maximize action. */
function MaximizeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}

/** Inward-corner icon for the card restore action. */
function RestoreIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 4v3a2 2 0 0 1-2 2H4" />
      <path d="M15 4v3a2 2 0 0 0 2 2h3" />
      <path d="M9 20v-3a2 2 0 0 0-2-2H4" />
      <path d="M15 20v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

export function FloatingCopilot() {
  const { state, actions } = useZule();
  const { defaultMode, apiKey, customModes } = state;
  const { stopCopilot, navigateTo } = actions;

  // State
  const [isHidden, setIsHidden] = useState(false);
  const [isInvisible, setIsInvisible] = useState(false);
  const [isPanicHidden, setIsPanicHidden] = useState(false);
  // Screen-capture stealth state. OverlayManager.create() applies
  // setContentProtection(true) by default, so the overlay is invisible
  // to screen recorders from first paint. The user toggles this off
  // when they want to make the overlay visible during a screen share.
  const [isStealth, setIsStealth] = useState(true);
  const [activeMode, setActiveMode] = useState<CopilotMode>(defaultMode);
  const [inputText, setInputText] = useState('');
  const [aiResponse, setAiResponse] = useState<AIResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  // Echo the most-recent user question above the AI response so the user
  // can see what they asked. Cleared when the user explicitly resets the
  // mode (handleModeChange) or stops the session.
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  // Chat history: accumulates all Q&A pairs for the session
  const [chatHistory, setChatHistory] = useState<{ id: string; role: 'user' | 'assistant'; text: string; isSimulated?: boolean }[]>([]);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [aiSuggestionCount, setAiSuggestionCount] = useState(0);
  const [coaching, setCoaching] = useState<SentimentResult | null>(null);
  const [showCoaching, setShowCoaching] = useState(true);
  const [activeSpeakerId, setActiveSpeakerId] = useState(() => speakerManager.getActiveSpeaker().id);
  const [modalitiesUsed, setModalitiesUsed] = useState<('audio' | 'screen' | 'knowledge' | 'memory')[]>([]);
  const [citations, setCitations] = useState<CitationInfo[]>([]);

  // Hooks
  const speech = useTranscription();
  const screen = useScreenCapture();
  const { position, setPosition, dragRef, handleRef } = useDraggable();
  const { broadcastState } = useCrossWindowSync('host');
  const { isElectronEnv, api: electronAPI } = useElectronBridge();
  const {
    mode: overlayMode,
    isCompact,
    isMaximized,
    toggleMode,
    toggleMaximize,
    setMode: setOverlayMode,
    modeAnnouncement,
  } = useOverlayMode();

  // Ref mirrors overlayMode so callbacks always read the current value
  // without needing it in their dependency array (which causes stale closures).
  const overlayModeRef = useRef(overlayMode);
  overlayModeRef.current = overlayMode;

  // Detect native overlay mode — when rendered inside the Electron Overlay_Window
  // (loaded at #overlay), positioning is handled by the native window itself
  // and the internal useDraggable should not apply CSS left/top (Req 10.4).
  // The flag is captured at module load in main.tsx (before React mounts) and
  // pinned on `window.__zuleIsOverlay` so it survives ZuleProvider's hash-sync
  // effect, which would otherwise overwrite #overlay with #dashboard.
  const isNativeOverlay =
    typeof window !== 'undefined' &&
    ((window as Window & { __zuleIsOverlay?: boolean }).__zuleIsOverlay === true ||
      window.location.hash === '#overlay');

  // In Electron, content protection is enabled by default from main.ts.
  // Listen for global shortcut events from the main process.
  useEffect(() => {
    if (!isElectronEnv) return;
    const cleanup = electronAPI.onGlobalShortcut((shortcutId: string) => {
      switch (shortcutId) {
        case 'toggle-overlay':
          setIsHidden((prev) => !prev);
          break;
        case 'panic-hide':
          setIsHidden(true);
          setIsPanicHidden(true);
          speech.pause();
          if (screen.isCapturing) screen.stopCapture();
          if (abortControllerRef.current) abortControllerRef.current.abort();
          break;
        case 'bring-to-front':
          setIsHidden(false);
          setIsPanicHidden(false);
          break;
      }
    });
    return cleanup;
  }, [isElectronEnv]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settings: whether to send a downscaled keyframe when the adapter supports images (Req 23.3)
  const [sendScreenKeyframe, setSendScreenKeyframe] = useState(false);

  // Refs
  const startTimeRef = useRef(Date.now());
  const questionDetectorRef = useRef(new QuestionDetectorStream({ debounceMs: 1500 }));
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bug Fix #1: useRef to track streaming state to avoid stale closure
  const isStreamingRef = useRef(false);
  // Bug Fix #3: ref guard so speech.start() fires only once
  const speechStartedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const summaryAbortControllerRef = useRef<AbortController | null>(null);
  // Generation counter for discarding late tokens from aborted streams (Req 12.2)
  const requestIdRef = useRef(0);
  // Req 12.5: Stable refs for values that change every transcript update,
  // so triggerAI's useCallback deps remain stable and the autonomous-detection
  // useEffects do not re-fire on every render.
  const transcriptRef = useRef(speech.transcript);
  transcriptRef.current = speech.transcript;
  const screenTextRef = useRef(screen.screenText);
  screenTextRef.current = screen.screenText;
  // Ref for keyframe capture so triggerAI can access it stably (Req 23.3)
  const getKeyframeBase64Ref = useRef(screen.getKeyframeBase64);
  getKeyframeBase64Ref.current = screen.getKeyframeBase64;
  const sendScreenKeyframeRef = useRef(sendScreenKeyframe);
  sendScreenKeyframeRef.current = sendScreenKeyframe;
  // Ref to hold the latest triggerAI so effects can call it without depending on it
  const triggerAIRef = useRef<(query?: string) => Promise<void>>(async () => {});

  // Timer
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // (Auto-grow is now handled synchronously in handleSubmit — see above.
  // The effect-based approach was removed because it had timing issues with
  // the async resize chain and stale overlayMode values.)

  // Load sendScreenKeyframe setting from IndexedDB (Requirement 23.3)
  useEffect(() => {
    knowledgeBase.getSetting<boolean>('sendScreenKeyframe', false).then((value) => {
      setSendScreenKeyframe(value);
    });
  }, []);

  // Unmount cleanup: abort any in-flight AI request (Req 12.1)
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      // Increment requestId so any late tokens are discarded
      requestIdRef.current += 1;
    };
  }, []);

  // Sync state to detached window
  useEffect(() => {
    broadcastState({
      isDetached: isInvisible,
      transcript: speech.transcript,
      interimText: speech.interimText,
      streamingText,
      aiResponse,
      isLoading,
      isStreaming,
      elapsedTime,
      coaching,
      activeMode,
    });
  }, [isInvisible, speech.transcript, speech.interimText, streamingText, aiResponse, isLoading, isStreaming, elapsedTime, coaching, activeMode, broadcastState]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [speech.transcript]);

  // Auto-scroll chat to latest message
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, streamingText]);

  const handleToggleDetach = useCallback(() => {
    if (isElectronEnv) {
      // In Electron: toggle content protection (real OS-level stealth)
      const newStealth = !isInvisible;
      electronAPI.setContentProtection(newStealth);
      setIsInvisible(newStealth);
      toast.success(newStealth ? 'Stealth mode ON — invisible to screen share' : 'Stealth mode OFF');
    } else {
      // Web fallback: open detached popup window
      if (!isInvisible) {
        const width = 450;
        const height = 600;
        const left = window.screen.width - width - 20;
        const top = 100;
        window.open(
          window.location.origin + window.location.pathname + '#detached',
          `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`
        );
        toast.success('Detached window opened');
      }
      setIsInvisible(!isInvisible);
    }
  }, [isInvisible, isElectronEnv, electronAPI]);

  // Dedicated screen-share stealth toggle, wired to the segmented eye/eye-off
  // toggle on the control capsule. Calls the unified `toggleVisibilityProtection`
  // IPC which flips content protection on BOTH the dashboard and the overlay
  // window in one call. Success is silent (the slider's animation is feedback
  // enough); only genuine IPC failures surface a toast. In web mode the toggle
  // is a no-op since browsers can't OS-level-hide a window from screen capture.
  const handleToggleStealth = useCallback(
    (enabled: boolean) => {
      if (!isElectronEnv) {
        toast.error('Stealth requires the desktop app');
        return;
      }
      // Optimistic update — the slider animates immediately on click; if
      // the IPC fails we revert and surface a toast.
      setIsStealth(enabled);
      Promise.resolve(electronAPI.toggleVisibilityProtection(enabled))
        .then((ok) => {
          if (!ok) {
            setIsStealth(!enabled);
            toast.error('Could not change stealth mode');
          }
        })
        .catch(() => {
          setIsStealth(!enabled);
          toast.error('Could not change stealth mode');
        });
    },
    [isElectronEnv, electronAPI],
  );

  // Panic hide: hide overlay, mute mic, stop screen capture, pause autonomous AI (Requirement 15.8)
  // All actions happen synchronously within the same event-loop tick (~<200ms)
  const handlePanicHide = useCallback(() => {
    if (isPanicHidden) {
      // Resume: show overlay, resume mic, but do NOT auto-restart screen capture
      setIsHidden(false);
      setIsPanicHidden(false);
      speech.resume();
    } else {
      // Panic: hide overlay, mute mic, stop capture, pause autonomous AI
      setIsHidden(true);
      setIsPanicHidden(true);
      speech.pause();
      if (screen.isCapturing) {
        screen.stopCapture();
      }
      // Abort any in-flight AI request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    }
  }, [isPanicHidden, speech, screen]);

  // Handle coaching and simulated response updates
  useEffect(() => {
    if (speech.transcript.length === 0) return;
    const fullText = speech.transcript.map(l => l.text).join(' ');
    const totalWords = fullText.split(/\s+/).length;
    const analysis = getFullAnalysis(fullText, totalWords, elapsedTime);
    setCoaching(analysis);
  }, [speech.transcript, elapsedTime]);

  // Autonomous question detection
  // Req 12.5: Call triggerAIRef.current() so this effect does NOT depend on triggerAI
  useEffect(() => {
    if (isPanicHidden) return; // Paused during panic hide (Requirement 15.8)
    if (speech.transcript.length > 0) {
      const recentContext = speech.transcript.slice(-3); // Get last 3 lines for context
      questionDetectorRef.current.onNewContext(recentContext, async () => {
        await triggerAIRef.current();
      });
    }
  }, [speech.transcript, isPanicHidden]);

  // Predictive pre-warming detection
  // Req 12.5: Call triggerAIRef.current() so this effect does NOT depend on triggerAI
  useEffect(() => {
    if (isPanicHidden) return; // Paused during panic hide (Requirement 15.8)
    if (speech.interimText) {
      questionDetectorRef.current.onInterimText(speech.interimText, async () => {
        // Trigger speculative generation. We append the interim text to the context
        // to pre-warm the LLM.
        await triggerAIRef.current(speech.interimText);
      });
    }
  }, [speech.interimText, isPanicHidden]);

  // Bug Fix #3: Start mic by default — check isSupported AND use ref guard
  useEffect(() => {
    if (speech.isSupported && !speechStartedRef.current) {
      speechStartedRef.current = true;
      speech.start();
    }
  }, []);

  // Bug Fix #1: triggerAI uses isStreamingRef instead of stale isStreaming closure
  // Req 12.2: Manual-override abort — abort in-flight request, discard late tokens via requestId
  // Req 12.5: useCallback with only stable deps (refs for transcript/screenText/activeMode)
  const activeModeRef = useRef(activeMode);
  activeModeRef.current = activeMode;
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
  const customModesRef = useRef(customModes);
  customModesRef.current = customModes;

  const triggerAI = useCallback(async (query?: string) => {
    setIsLoading(true);
    setIsStreaming(false);
    isStreamingRef.current = false;

    // Abort any in-flight request (Req 12.2: manual-override abort)
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Increment request ID so late tokens from aborted stream are discarded
    requestIdRef.current += 1;
    const currentRequestId = requestIdRef.current;
    // Reset streaming text for the new request
    setStreamingText('');

    try {
      // Read current values from refs (Req 12.5: stable deps)
      const currentTranscript = transcriptRef.current;
      const currentScreenText = screenTextRef.current;
      const currentActiveMode = activeModeRef.current;
      const currentApiKey = apiKeyRef.current;
      const currentCustomModes = customModesRef.current;

      // Determine the core query for caching purposes
      const coreQuery = query || (currentTranscript.length > 0 ? currentTranscript[currentTranscript.length - 1].text : '');
      
      // Check Semantic Cache first
      if (coreQuery) {
        const { hit } = await semanticCache.get(coreQuery);
        if (hit) {
          // Only apply if this request is still current
          if (requestIdRef.current !== currentRequestId) return;
          console.log('Semantic cache hit for:', coreQuery);
          // Normalize cache hit to the AIResponse shape expected by UI components
          setAiResponse({
            text: hit.text,
            suggestions: [],
            followUps: [],
            isSimulated: hit.isSimulated,
          });
          // Append cached assistant message to chat history
          setChatHistory(prev => [...prev, { id: generateId(), role: 'assistant', text: hit.text, isSimulated: hit.isSimulated }]);
          setIsLoading(false);
          setIsStreaming(false);
          isStreamingRef.current = false;
          setAiSuggestionCount(prev => prev + 1);
          return;
        }
      }

      const context = await buildContextWindow(
        currentActiveMode,
        toLegacyTranscript(currentTranscript),
        currentScreenText,
        query || '',
        currentCustomModes,
        // Pass a downscaled keyframe when adapter supports image input and user opted in (Req 23.3)
        sendScreenKeyframeRef.current && activeAdapterSupportsImageInput()
          ? (() => {
              const base64 = getKeyframeBase64Ref.current();
              return base64
                ? { images: [{ mimeType: 'image/jpeg', base64 }] }
                : undefined;
            })()
          : undefined,
      );

      // Check if this request is still current after async context build
      if (requestIdRef.current !== currentRequestId) return;

      // Store modalities and citations from the context window (Requirement 23.4, 5.5)
      if (context.modalitiesUsed) {
        setModalitiesUsed(context.modalitiesUsed);
      }
      if (context.citations) {
        setCitations(context.citations);
      }

      await streamAIResponse(
        context,
        {
          onToken: (partialText) => {
            // Discard late tokens: only update state if requestId matches (Req 12.2)
            if (requestIdRef.current !== currentRequestId) return;
            if (!isStreamingRef.current) {
              setIsLoading(false);
              setIsStreaming(true);
              isStreamingRef.current = true;
            }
            setStreamingText(partialText);
          },
          onComplete: (response) => {
            // Discard completion from aborted stream (Req 12.2)
            if (requestIdRef.current !== currentRequestId) return;
            // Save to Semantic Cache if it was a good response
            if (coreQuery && !response.isSimulated && response.text.trim()) {
              void semanticCache.set(coreQuery, {
                text: response.text,
                isSimulated: response.isSimulated,
                status: (response as any).status ?? 200,
              });
            }
            setAiResponse(response);
            // Append assistant message to chat history
            setChatHistory(prev => [...prev, { id: generateId(), role: 'assistant', text: response.text, isSimulated: response.isSimulated }]);
            setStreamingText('');
            setIsStreaming(false);
            isStreamingRef.current = false;
            setAiSuggestionCount(prev => prev + 1);
          },
          onError: (error) => {
            if (error.name === 'AbortError') {
              return; // Ignore aborted requests
            }
            // Discard errors from stale requests
            if (requestIdRef.current !== currentRequestId) return;
            toast.error('AI streaming encountered an error. Please try again.');
            setIsStreaming(false);
            isStreamingRef.current = false;
            setIsLoading(false);
            setAiResponse({
              text: 'Sorry, I encountered an error generating a response. Please try again.',
              suggestions: [],
              followUps: [],
              isSimulated: true,
            });
          },
        },
        currentApiKey,
        abortControllerRef.current.signal
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return; // Ignore aborted requests
      }
      // Discard errors from stale requests
      if (requestIdRef.current !== currentRequestId) return;
      toast.error('AI generation failed. Please try again.');
      setIsStreaming(false);
      isStreamingRef.current = false;
      setIsLoading(false);
      setAiResponse({
        text: 'Sorry, I encountered an error generating a response. Please try again.',
        suggestions: [],
        followUps: [],
        isSimulated: true,
      });
    }
    // Req 12.5: No deps that change every render — all mutable values read from refs
  }, []);

  // Req 12.5: Keep triggerAIRef in sync so effects can call without depending on triggerAI
  triggerAIRef.current = triggerAI;

  const handleSubmit = useCallback(() => {
    if (inputText.trim()) {
      const q = inputText.trim();
      setLastQuestion(q);
      // Append user message to chat history
      setChatHistory(prev => [...prev, { id: generateId(), role: 'user', text: q }]);
      // Auto-grow the overlay when asking a question (Cluely parity).
      if (isNativeOverlay && overlayModeRef.current === 'expanded') {
        setOverlayMode('maximized');
      }
      triggerAIRef.current(q);
      setInputText('');
    } else {
      setLastQuestion('(using current screen / conversation)');
      // Append user message to chat history
      setChatHistory(prev => [...prev, { id: generateId(), role: 'user', text: '(using current screen / conversation)' }]);
      if (isNativeOverlay && overlayModeRef.current === 'expanded') {
        setOverlayMode('maximized');
      }
      triggerAIRef.current();
    }
  }, [inputText, isNativeOverlay, setOverlayMode]);

  // Use Screen — toggle screen capture + keyframe attachment for the next
  // AI request. Click once to enable: starts the capture session and arms
  // the keyframe-on-next-question flag. Click again to disable: stops the
  // capture and clears the flag. Cluely-parity: the button stays "active"
  // (blue tint) while screen context is armed, off otherwise. Errors are
  // surfaced via toast so failures never silently disappear.
  const handleUseScreen = useCallback(async () => {
    try {
      const isActive = screen.isCapturing && sendScreenKeyframeRef.current;
      if (isActive) {
        // Toggle OFF: stop the capture and disarm the flag. We don't
        // fire an AI request on disable — the user just wanted to
        // detach the screen, not ask another question.
        screen.stopCapture();
        sendScreenKeyframeRef.current = false;
        setSendScreenKeyframe(false);
        void knowledgeBase.setSetting('sendScreenKeyframe', false);
        toast.success('Screen detached');
        return;
      }
      // Toggle ON: start capture if not already running, arm the flag,
      // then immediately fire an AI request with the screen as context.
      if (!screen.isCapturing) {
        await screen.startCapture();
        toast.success('Screen attached');
      } else {
        toast.success('Using current screen capture');
      }
      sendScreenKeyframeRef.current = true;
      setSendScreenKeyframe(true);
      void knowledgeBase.setSetting('sendScreenKeyframe', true);

      // Wait for the video element to have a frame ready for capture.
      // startCapture() resolves after play() but the video might not have
      // decoded its first frame yet. Poll briefly (up to 2s) so the
      // keyframe capture doesn't return null.
      const video = screen.previewRef?.current;
      if (video && video.readyState < video.HAVE_ENOUGH_DATA) {
        await new Promise<void>((resolve) => {
          const onReady = () => { resolve(); video.removeEventListener('loadeddata', onReady); };
          video.addEventListener('loadeddata', onReady);
          // Safety timeout so we don't hang forever
          setTimeout(() => { video.removeEventListener('loadeddata', onReady); resolve(); }, 2000);
        });
      }

      // Echo what we're asking so the user sees feedback.
      const query = inputText.trim();
      const echoed = query || 'What do you see on my screen?';
      setLastQuestion(echoed);
      // Append user message to chat history
      setChatHistory(prev => [...prev, { id: generateId(), role: 'user', text: echoed }]);
      if (query) setInputText('');
      await triggerAIRef.current(query || undefined);
    } catch (err) {
      console.error('[FloatingCopilot] Use Screen failed:', err);
      toast.error(
        err instanceof Error
          ? `Screen capture failed: ${err.message}`
          : 'Screen capture failed',
      );
    }
  }, [screen, inputText]);

  const handleModeChange = useCallback((mode: CopilotMode) => {
    setActiveMode(mode);
    setAiResponse(null);
    setLastQuestion(null);
    setChatHistory([]);
  }, []);

  const handleStop = useCallback(async () => {
    // Prevent double-click while summary is in flight (Requirement 27.4)
    if (isGeneratingSummary) return;

    speech.stop();
    screen.stopCapture();
    questionDetectorRef.current.reset();

    setIsGeneratingSummary(true);

    const transcriptLines = speech.transcript.map(l => ({
      id: l.id,
      text: l.text,
      timestamp: l.timestamp,
      speaker: l.speakerId,
      isInterim: l.isInterim,
    }));

    // Step 1: Persist placeholder meeting FIRST (Requirement 27.1)
    // This ensures the transcript is never lost even if the tab closes mid-generation.
    const meetingId = `meeting-${generateId()}`;
    const placeholderMeeting = await persistPlaceholderMeeting({
      id: meetingId,
      title: `${MODE_CONFIGS[activeMode].label} Session`,
      mode: activeMode,
      startedAt: startTimeRef.current,
      endedAt: Date.now(),
      duration: elapsedTime,
      transcript: transcriptLines,
      aiSuggestionCount,
      fillerCount: coaching?.fillerCount || 0,
      avgConfidence: coaching?.confidenceScore || 0,
      wordsPerMinute: coaching?.wordsPerMinute || 0,
    });

    // Set up cancellation support (Requirement 27.4)
    const summaryAbortController = new AbortController();
    summaryAbortControllerRef.current = summaryAbortController;

    // Step 2-4: Generate summary with 60s timeout (Requirements 27.2, 27.3)
    const result = await generateSummaryWithTimeout(
      placeholderMeeting,
      apiKey,
      summaryAbortController.signal,
    );

    summaryAbortControllerRef.current = null;
    setIsGeneratingSummary(false);

    // Navigate to meeting detail with the final meeting state
    stopCopilot(result.meeting);
  }, [speech, screen, activeMode, elapsedTime, aiSuggestionCount, coaching, apiKey, stopCopilot, isGeneratingSummary]);

  // Nudge step for 8-direction reposition shortcuts (Req 18.4)
  const NUDGE_PX = 40;

  const nudgePosition = useCallback((dx: number, dy: number) => {
    setPosition(prev => {
      const el = dragRef.current;
      const width = el ? el.getBoundingClientRect().width : 400;
      const height = el ? el.getBoundingClientRect().height : 600;
      const clamped = clampPosition(
        { x: prev.x + dx, y: prev.y + dy, width, height },
        { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight },
      );
      return clamped;
    });
  }, [setPosition, dragRef]);

  const recenterPosition = useCallback(() => {
    const el = dragRef.current;
    const width = el ? el.getBoundingClientRect().width : 400;
    const height = el ? el.getBoundingClientRect().height : 600;
    setPosition({
      x: Math.max(0, (window.innerWidth - width) / 2),
      y: Math.max(0, (window.innerHeight - height) / 2),
    });
  }, [setPosition, dragRef]);

  // Keyboard shortcuts
  useKeyboardShortcuts([
    { key: 'h', ctrl: true, shift: true, action: () => setIsHidden(prev => !prev), description: 'Toggle hide' },
    { key: 'Enter', ctrl: true, action: handleSubmit, description: 'Submit' },
    { key: 'm', ctrl: true, shift: true, action: () => speech.isListening ? speech.pause() : speech.resume(), description: 'Toggle mic' },
    { key: 's', ctrl: true, shift: true, action: () => {
        const nextId = activeSpeakerId === 'speaker-1' ? 'speaker-2' : 'speaker-1';
        speakerManager.setActiveSpeaker(nextId);
        setActiveSpeakerId(nextId);
      }, description: 'Toggle speaker' },
    { key: 'Escape', action: () => setIsHidden(true), description: 'Hide overlay' },
    // 8-direction reposition shortcuts (Req 18.4)
    { key: 'ArrowUp', ctrl: true, alt: true, action: () => nudgePosition(0, -NUDGE_PX), description: 'Nudge up' },
    { key: 'ArrowDown', ctrl: true, alt: true, action: () => nudgePosition(0, NUDGE_PX), description: 'Nudge down' },
    { key: 'ArrowLeft', ctrl: true, alt: true, action: () => nudgePosition(-NUDGE_PX, 0), description: 'Nudge left' },
    { key: 'ArrowRight', ctrl: true, alt: true, action: () => nudgePosition(NUDGE_PX, 0), description: 'Nudge right' },
    { key: '0', ctrl: true, alt: true, action: recenterPosition, description: 'Recenter overlay' },
    { key: '\\', ctrl: true, shift: true, action: handlePanicHide, description: 'Panic hide' },
  ]);

  return (
    <div className="copilot-workspace">
      {/* Background workspace — only shown in non-overlay (Mode 1) */}
      {!isNativeOverlay && (
        <div className="copilot-bg">
          <button className="copilot-back-btn" onClick={() => navigateTo('dashboard')}>
            <ArrowLeft size={16} />
            <span>Exit Copilot</span>
          </button>

          <div className="copilot-bg-content">
            {isInvisible && !isHidden && (
              <div className="detached-warning" style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                <div style={{ marginBottom: '10px' }}>
                  <Sparkles size={24} color="var(--primary-color)" />
                </div>
                <h4>Copilot is Detached</h4>
                <p style={{ fontSize: '13px', marginTop: '8px' }}>
                  The UI is currently running in a separate, invisible window to prevent it from showing on screen shares.
                </p>
              </div>
            )}

            {isGeneratingSummary && !isHidden && !isInvisible && (
              <div className="detached-warning" style={{ padding: '20px', textAlign: 'center', color: 'var(--primary-color)' }}>
                <div style={{ marginBottom: '10px' }}>
                  <Sparkles size={24} className="spin" />
                </div>
                <h4>Generating Summary...</h4>
                <p style={{ fontSize: '13px', marginTop: '8px' }}>
                  Zule is reviewing the transcript to create your meeting notes and action items.
                </p>
                <button
                  className="btn-secondary"
                  style={{ marginTop: '12px', fontSize: '12px' }}
                  onClick={() => {
                    if (summaryAbortControllerRef.current) {
                      summaryAbortControllerRef.current.abort();
                    }
                  }}
                >
                  Cancel Summary
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== FLOATING OVERLAY (Cluely-style) ===== */}
      {/* In native overlay mode, the BrowserWindow itself handles position
          via `-webkit-app-region: drag`. The internal useDraggable positioning
          is disabled (left/top forced to 0) so the capsule fills the window
          and dragging the capsule moves the native window (Req 10.4). */}
      <div
        ref={dragRef}
        className={`copilot-overlay ${isInvisible ? 'invisible-mode' : ''} ${isNativeOverlay ? `native-overlay-mode mode-2-card-root overlay-${overlayMode}` : ''}`}
        data-zule-stealth="true"
        role="region"
        aria-label="Zule AI copilot"
        style={
          isNativeOverlay
            ? { left: 0, top: 0, position: 'relative' }
            : { left: position.x, top: position.y }
        }
      >
        <ControlCapsule
          isHidden={isHidden}
          onToggleHidden={() => setIsHidden(!isHidden)}
          onStop={handleStop}
          handleRef={(node) => { handleRef.current = node as HTMLDivElement; }}
          overlayMode={overlayMode}
          onToggleMode={toggleMode}
          isStealth={isStealth}
          onToggleStealth={isElectronEnv ? handleToggleStealth : undefined}
        />

        {/* aria-live announcer for mode transitions (Requirement 13.5) */}
        <div
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap' }}
        >
          {modeAnnouncement}
        </div>

        {/* Compact mode: single suggestion preview with ellipsis truncation (Requirement 9.3).
            Hidden in native overlay mode — the capsule alone is sufficient chrome
            when compact; the "Listening..." text is distracting on a transparent
            always-on-top widget. */}
        {isCompact && !isNativeOverlay && (
          <div
            className="compact-suggestion-preview"
            aria-label="Suggestion preview"
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: '12px',
              padding: '0 12px',
              color: 'var(--text-secondary)',
              maxWidth: '100%',
            }}
          >
            {isLoading
              ? 'Thinking...'
              : isStreaming && streamingText
                ? streamingText.split('\n')[0]
                : aiResponse?.text
                  ? aiResponse.text.split('\n')[0]
                  : 'Listening...'}
          </div>
        )}

        {/* --- Suggestion Card (Cluely-style Layout-Isolated Panel) ---
            Three strict layout zones inside a height-locked flex column:
              Top Zone    → .card-header (flex-shrink: 0)
              Middle Zone → .card-scroll-body (flex: 1, overflow-y: auto)
              Bottom Zone → QuickActions + InputBar (flex-shrink: 0)
            The outer card NEVER changes dimensions. All overflow is
            absorbed exclusively by the scroll body. */}
        <div
          className={`suggestion-card ${isHidden || isCompact ? 'hidden' : ''}`}
          aria-hidden={isCompact || undefined}
          tabIndex={isCompact ? -1 : undefined}
        >
          {/* ═══ TOP ZONE: Fixed header — never scrolls ═══ */}
          <div className="card-header">
            <div className="card-mode-pill">
              <span>{MODE_CONFIGS[activeMode].icon}</span>
              <span>{MODE_CONFIGS[activeMode].label}</span>
            </div>
            {isNativeOverlay && !isCompact && (
              <button
                type="button"
                className={`card-maximize-btn ${isMaximized ? 'is-maximized' : ''}`}
                onClick={toggleMaximize}
                aria-label={isMaximized ? 'Restore overlay size' : 'Maximize overlay'}
                aria-pressed={isMaximized}
                title={isMaximized ? 'Restore' : 'Maximize'}
              >
                {isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
              </button>
            )}
          </div>

          {/* ═══ MIDDLE ZONE: Scrollable content — the ONLY region that scrolls ═══
              Contains chat history (user questions + AI responses), modality badges,
              ratings, and follow-ups. When content overflows, only this region scrolls.
              Header and bottom controls stay permanently anchored. */}
          <div className="card-scroll-body">
            {/* Render full chat history */}
            {chatHistory.map((msg) => (
              msg.role === 'user' ? (
                <div key={msg.id} className="user-message" aria-label="Your question">
                  <span className="user-message-bubble">{msg.text}</span>
                </div>
              ) : (
                <div key={msg.id} className="card-suggestion" aria-live="polite">
                  <div className="suggestion-text markdown-content">
                    {msg.isSimulated && (
                      <div className="simulation-warning">
                        <span><strong>Simulation Mode:</strong> Add your Gemini API key in Settings for real AI responses.</span>
                      </div>
                    )}
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.text}
                    </ReactMarkdown>
                  </div>
                </div>
              )
            ))}
            {/* Show current streaming / loading state for the in-flight response */}
            {(isLoading || isStreaming) && (
              <SuggestionCard
                isLoading={isLoading}
                isStreaming={isStreaming}
                streamingText={streamingText}
                aiResponse={null}
                onTriggerAI={triggerAI}
                modalitiesUsed={modalitiesUsed}
                citations={citations}
                onCitationClick={(citation) => {
                  if (citation.label === '[MEMORY]' && citation.source?.meetingId) {
                    navigateTo('meeting-detail');
                  }
                }}
              />
            )}
            {/* Show placeholder when no chat history and not loading */}
            {chatHistory.length === 0 && !isLoading && !isStreaming && (
              <SuggestionCard
                isLoading={false}
                isStreaming={false}
                streamingText=""
                aiResponse={null}
                onTriggerAI={triggerAI}
                modalitiesUsed={modalitiesUsed}
                citations={citations}
                onCitationClick={(citation) => {
                  if (citation.label === '[MEMORY]' && citation.source?.meetingId) {
                    navigateTo('meeting-detail');
                  }
                }}
              />
            )}
            {/* Follow-up suggestions from the latest response */}
            {aiResponse && aiResponse.followUps && aiResponse.followUps.length > 0 && !isStreaming && (
              <div className="card-followups">
                {aiResponse.followUps.map((fu, i) => (
                  <button
                    key={i}
                    className="followup-chip"
                    onClick={() => triggerAI(fu)}
                  >
                    {fu}
                  </button>
                ))}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* ═══ BOTTOM ZONE: Anchored controls — always visible ═══ */}
          <QuickActions
            activeMode={activeMode}
            onModeChange={handleModeChange}
          />

          <InputBar
            inputText={inputText}
            onInputChange={setInputText}
            onSubmit={handleSubmit}
            isLoading={isLoading}
            inputRef={inputRef}
            onUseScreen={handleUseScreen}
            isScreenActive={screen.isCapturing && sendScreenKeyframe}
          />
        </div>
      </div>
    </div>
  );
}
