// ============================================
// Zule AI — Floating Copilot (Exact Cluely UI)
// Decomposed into sub-components with bug fixes
// ============================================

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ArrowLeft, Sparkles, Copy } from 'lucide-react';
import { useZule } from '../context/ZuleContext';
import { useAuth } from '../firebase/AuthContext';
import { useTranscription } from '../hooks/useTranscription';
import { useSystemAudioTranscription } from '../hooks/useSystemAudioTranscription';
import { useScreenCapture } from '../hooks/useScreenCapture';
import { warmOcrWorker } from '../workers/ocrWorker';
import { useDraggable } from '../hooks/useDraggable';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useCrossWindowSync } from '../hooks/useCrossWindowSync';
import { useElectronBridge } from '../hooks/useElectronBridge';
import { clampPosition } from '../utils/geometry';
import { ocrBase64Image } from '../utils/ocrImage';
import { speakerManager } from '../brain/speakerManager';
import { persistPlaceholderMeeting, generateSummaryWithTimeout } from '../brain/stopSession';
import { buildContextWindow, buildMinimalScreenContext, primeFastContext } from '../brain/contextManager';
import type { TranscriptLine, CitationInfo } from '../brain/contextManager';
import type { TranscriptionLine } from '../types/transcription';
import { streamAIResponse, describeProviderFailure, warmProviders } from '../brain/aiProvider';
import type { AIResponse } from '../brain/aiProvider';
import { activeAdapterSupportsImageInput, hasVisionProvider, NoVisionProviderError } from '../brain/aiProvider';
import { database as knowledgeBase } from '../data/database';
import { QuestionDetectorStream } from '../brain/questionDetector';
import { getFullAnalysis } from '../brain/sentimentAnalyzer';
import { semanticCache } from '../brain/responseCache';
import { screenCacheKey, getScreenCached, setScreenCached } from '../brain/screenFastCache';
import { ScreenContextGuard } from '../brain/screenContextGuard';
import { telemetry } from '../brain/telemetry';
import type { SentimentResult } from '../brain/sentimentAnalyzer';
import { MODE_CONFIGS, type CopilotMode } from '../brain/modePrompts';
import { generateId } from '../utils/formatters';
import toast from 'react-hot-toast';

import { ControlCapsule } from './copilot/ControlCapsule';
import { SuggestionCard } from './copilot/SuggestionCard';
import { QuickActions } from './copilot/QuickActions';
import { InputBar } from './copilot/InputBar';
import { PhoneCapture } from './copilot/PhoneCapture';
import { useOverlayMode } from '../overlay/useOverlayMode';
import { UpdateIndicator } from './UpdateIndicator';
import { useAutoUpdate } from '../hooks/useAutoUpdate';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSubscription } from '../context/SubscriptionContext';
import { UpgradeModal } from './UpgradeModal';
import type { GatedFeature } from '../types/subscription';

import './FloatingCopilot.css';


// --- Latency budget for the dispatch path ---------------------------------
//
// Every millisecond spent here sits between the User's click and the first
// streamed token, so these ceilings are deliberately tight. The previous
// 3 000 ms values were sized as "don't hang forever" guards, but a timeout on
// the critical path doubles as the p99 latency of its stage — and a UI
// Automation walk that hasn't returned within ~1.2 s is not about to return
// useful text, it is a window that exposes no text tree at all. Failing over to
// the next capture method beats waiting out the timeout.
/**
 * Budget for the UI Automation text walk.
 *
 * This one is easy to set too low, because the name suggests a native API call.
 * It is not: `extractForegroundText` spawns `powershell.exe`, loads the
 * `System.Windows.Automation` assemblies, then walks every descendant of the
 * foreground window running three pattern queries per element. Process start
 * alone is a few hundred milliseconds, and a browser window exposes thousands of
 * accessibility nodes — the native side allows itself 5 s for good reason.
 *
 * Cutting this to ~1.2 s (which is roughly what the walk costs on a *simple*
 * window) means it reliably expires on exactly the windows it exists to handle,
 * and UIA is the only text source that survives `SetWindowDisplayAffinity`. When
 * it expires the fallback is not a cheaper capture, it is an image — which a
 * text-only model cannot read. So the budget has to be large enough for the walk
 * to finish; making the walk itself cheap is a separate problem, and the real fix
 * is to stop paying for it on the critical path at all.
 */
const UIA_TIMEOUT_MS = 4000;

/**
 * The budget when the foreground window is capture-protected.
 *
 * Every other source is already known to be a dead end in that case, so a 4s
 * give-up returns nothing at all rather than something cheaper. The main process
 * kills its PowerShell at 5000ms, so waiting slightly past that costs nothing and
 * turns a discarded in-flight result into a usable one.
 */
const UIA_PROTECTED_TIMEOUT_MS = 5500;

const BITBLT_TIMEOUT_MS = 1500;

/**
 * OCR gets a far larger budget than the other two capture methods, because it
 * is not one of several ways to get the same thing — it is the last one. UIA and
 * BitBlt have already failed by the time it runs, so its alternative is not a
 * cheaper capture, it is *no screen text at all*.
 *
 * A Tesseract pass over a full-resolution frame routinely needs several seconds.
 * Capping it at the same ~1.5 s as the others converts a slow success into a hard
 * failure, and a hard failure is the more expensive outcome by a wide margin: the
 * model receives an empty context and answers "no conversation context was
 * included", so the User waits, gets nothing usable, and dispatches again.
 * Waiting out a slow OCR is strictly better than paying for a round trip that
 * cannot succeed.
 */
const OCR_TIMEOUT_MS = 8000;

/**
 * Ceiling on the Knowledge_Base + Memory_Store lookup for conversational
 * (non-screen) questions. Retrieval enriches an answer; it does not gate one.
 *
 * Caveat, and it is a large one: this deadline is a backstop, not a guarantee.
 * `transformersEnv` pins the ONNX WASM backend to `numThreads = 1` and
 * `proxy = false`, so an embedding runs on the renderer main thread and blocks
 * the event loop — the `setTimeout` behind this race cannot fire until the
 * forward pass has already finished. It only bounds the *awaitable* part of
 * retrieval (IndexedDB reads, persistence hydration).
 *
 * What actually keeps retrieval off the critical path is refusing to start it:
 * `buildMinimalScreenContext` for screen dispatches, and the empty-corpus guards
 * in `knowledgeBase.search` / `memoryStore.search` that return before embedding.
 */
const RETRIEVAL_DEADLINE_MS = 600;

/**
 * Ceiling on the embedding-backed Semantic_Cache lookup. A cache probe that
 * overruns is treated as a miss — the point of a cache is to save time, so it
 * is never allowed to cost more than it can save. Subject to the same
 * main-thread caveat as `RETRIEVAL_DEADLINE_MS`, which is why the screen path
 * uses the synchronous hash cache in `screenFastCache` instead of this one.
 */
const SEMANTIC_CACHE_DEADLINE_MS = 400;

/**
 * Timing instrumentation for the dispatch path. Emits one line per request so a
 * slow response can be attributed to a stage — capture, cache, context assembly
 * or provider — instead of guessed at.
 */
function makeStopwatch(label: string) {
  const t0 = performance.now();
  let last = t0;
  const marks: string[] = [];
  const notes: string[] = [];
  return {
    mark(name: string) {
      const now = performance.now();
      marks.push(`${name} ${Math.round(now - last)}ms`);
      last = now;
    },
    /**
     * Attach a non-timing fact to the report line — screenshot size, resolved
     * model. Stage timings alone cannot distinguish "the model is slow" from
     * "we sent it 900 KB of screenshot", and that distinction is the whole
     * question on this path.
     */
    note(text: string) {
      notes.push(text);
    },
    /**
     * Milliseconds since the dispatch started, without emitting anything. The
     * screen path needs the total twice — once at first token, once when the
     * answer completes and the resolved model id is finally known — and calling
     * `report` again would reprint the whole stage breakdown for a second line.
     */
    elapsed() {
      return Math.round(performance.now() - t0);
    },
    report(suffix?: string) {
      const total = Math.round(performance.now() - t0);
      const tail = [...notes, ...(suffix ? [suffix] : [])];
      // eslint-disable-next-line no-console
      console.log(
        `[perf] ${label} total ${total}ms — ${marks.join(' | ')}${tail.length ? ` | ${tail.join(' | ')}` : ''}`,
      );
      return total;
    },
  };
}

/**
 * Copy text to the clipboard from the overlay, reporting whether it worked.
 *
 * The async Clipboard API is not usable from this window. The overlay is created
 * `NOACTIVATE` and deliberately never takes focus — that is the entire point of
 * the focusless design — and `navigator.clipboard.writeText` rejects with
 * `NotAllowedError: Document is not focused` in exactly that situation. It does
 * so by *rejecting*, not by throwing, so a synchronous `try/catch` around it
 * catches nothing: the previous version of this handler set `copied = true` the
 * instant the promise was created, never ran its `execCommand` fallback, showed
 * a "Copied to clipboard" toast for an empty clipboard, and left an unhandled
 * `NotAllowedError` in the console on every click.
 *
 * So the promise is awaited, and the synchronous `execCommand('copy')` path —
 * which works without document focus because the selection it copies from is one
 * this document owns — is the fallback rather than the dead branch.
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand path below.
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Shape returned by the native BitBlt capture bridge. Named so the
 * `raceTimeout` fallback literals can be cast to the full shape — casting them
 * to a narrower one silently hides the diagnostic fields from every use site.
 */
type BitBltResult = {
  ok: boolean;
  base64?: string;
  reason?: string;
  bytes?: number;
  width?: number;
  height?: number;
};

/** Map new TranscriptionLine[] to legacy TranscriptLine[] for APIs still on the old type. */function toLegacyTranscript(lines: TranscriptionLine[]): TranscriptLine[] {
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
  const { user } = useAuth();
  const { defaultMode, apiKey, customModes } = state;
  const { stopCopilot, navigateTo } = actions;

  // State
  const [isHidden, setIsHidden] = useState(false);
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
  const [isGeneratingSummary] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  // A thinking model's chain-of-thought. Held separately from `streamingText`
  // because it is not part of the answer and must never be mistaken for one —
  // but it is the only thing arriving during a reasoning phase that can run for
  // a minute, so without it the overlay shows a bare "Thinking..." spinner and
  // is indistinguishable from a hung request.
  const [reasoningText, setReasoningText] = useState('');
  // Chat history: accumulates all Q&A pairs for the session
  const [chatHistory, setChatHistory] = useState<{ id: string; role: 'user' | 'assistant'; text: string; isSimulated?: boolean }[]>([]);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [aiSuggestionCount, setAiSuggestionCount] = useState(0);
  const [coaching, setCoaching] = useState<SentimentResult | null>(null);
  const [activeSpeakerId, setActiveSpeakerId] = useState(() => speakerManager.getActiveSpeaker().id);
  const [modalitiesUsed, setModalitiesUsed] = useState<('audio' | 'screen' | 'knowledge' | 'memory' | 'keyframe' | 'screenText')[]>([]);
  const [citations, setCitations] = useState<CitationInfo[]>([]);
  const [recognitionLanguage, setRecognitionLanguage] = useState<string | null>(null);
  // Detected question badge — flashes when autonomous trigger fires
  const [detectedQuestion, setDetectedQuestion] = useState<string | null>(null);

  // Subscription State
  const { isFeatureAvailable, isLimitReached, incrementUsage, limits } = useSubscription();
  const [upgradeModal, setUpgradeModal] = useState<{
    reason: 'meeting-limit' | 'ai-response-limit' | 'kb-doc-limit' | 'feature-locked';
    feature?: GatedFeature;
  } | null>(null);

  // Load speech recognition language from settings before starting the mic
  useEffect(() => {
    knowledgeBase.getSetting<string>('recognitionLanguage', 'en-US').then((lang) => {
      setRecognitionLanguage(lang);
    });
  }, []);

  // Hooks
  // Mic pipeline — the user's own voice. Tagged role 'user' so the
  // Question_Detector short-circuits on it (it should fire on the *other*
  // party, not on the user).
  const speech = useTranscription({
    speakerId: 'speaker-1',
    speakerRole: 'user',
    ...(recognitionLanguage ? { language: recognitionLanguage } : {}),
  });
  // System-audio (loopback) pipeline — the remote party's voice via Whisper.
  // Opt-in; tagged role 'other'. Lines are merged into `mergedTranscript`.
  const systemAudio = useSystemAudioTranscription(
    recognitionLanguage ? { language: recognitionLanguage } : undefined,
  );
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

  // Auto-update state for the overlay indicator (Requirements 7.1, 7.3)
  const { state: updateState } = useAutoUpdate();

  // Single transcript feeding the AI / detectors / UI: mic lines (role 'user')
  // and system-audio lines (role 'other') merged in timestamp order. Both
  // already carry epoch-ms timestamps, so a stable sort interleaves them.
  const mergedTranscript = useMemo(
    () =>
      [...speech.transcript, ...systemAudio.lines].sort(
        (a, b) => a.timestamp - b.timestamp,
      ),
    [speech.transcript, systemAudio.lines],
  );

  // Live captions: a short rolling window of the most recent transcribed lines
  // (so text reads continuously instead of vanishing as new speech arrives),
  // plus any in-progress interim text appended as a live, pulsing line. Mic
  // interim is real partial text; system-audio (Whisper) interim is just a '...'
  // working placeholder, so only mic interim is surfaced as live text.
  const CAPTION_HISTORY = 3;
  const liveCaptions = useMemo(() => {
    const recent = mergedTranscript
      .slice(-CAPTION_HISTORY)
      .map((l, i) => ({
        key: l.id ?? `final-${i}`,
        text: l.text,
        role: l.speakerRole,
        live: false,
      }));
    if (speech.interimText) {
      recent.push({
        key: 'interim',
        text: speech.interimText,
        role: 'user' as const,
        live: true,
      });
    }
    // Keep the window bounded even with the interim line appended.
    return recent.slice(-CAPTION_HISTORY);
  }, [speech.interimText, mergedTranscript]);

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
          systemAudio.pause();
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

  // Phone Camera Input state
  const [phoneServerActive, setPhoneServerActive] = useState(false);
  const [phoneServerUrl, setPhoneServerUrl] = useState<string | null>(null);
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);
  const [lastPhoneImageTime, setLastPhoneImageTime] = useState<number | null>(null);

  // Refs
  const startTimeRef = useRef(Date.now());
  const questionDetectorRef = useRef(new QuestionDetectorStream({ debounceMs: 800 }));
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bug Fix #1: useRef to track streaming state to avoid stale closure
  const isStreamingRef = useRef(false);
  const isLoadingRef = useRef(false);
  // Tracks whether the main mic was listening before in-bar dictation began,
  // so we only resume a mic the user hadn't already paused.
  const dictationWasListening = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Generation counter for discarding late tokens from aborted streams (Req 12.2)
  const requestIdRef = useRef(0);
  // Screen context guard for frame freshness and cross-request isolation (Req 8.1, 8.2, 8.3)
  const screenContextGuardRef = useRef(new ScreenContextGuard());
  // Req 12.5: Stable refs for values that change every transcript update,
  // so triggerAI's useCallback deps remain stable and the autonomous-detection
  // useEffects do not re-fire on every render.
  const transcriptRef = useRef(mergedTranscript);
  transcriptRef.current = mergedTranscript;
  const screenTextRef = useRef(screen.screenText);
  screenTextRef.current = screen.screenText;
  // Ref for keyframe capture so triggerAI can access it stably (Req 23.3)
  const getKeyframeBase64Ref = useRef(screen.getKeyframeBase64);
  getKeyframeBase64Ref.current = screen.getKeyframeBase64;
  // Ref for async keyframe capture (off-main-thread via FramePrepWorker, Req 5.1, 5.2)
  const getKeyframeAsyncRef = useRef(screen.getKeyframeAsync);
  getKeyframeAsyncRef.current = screen.getKeyframeAsync;
  // Ref for on-demand OCR so triggerAI can refresh screen text without taking
  // an unstable dependency (Req 12.5).
  const captureTextNowRef = useRef(screen.captureTextNow);
  captureTextNowRef.current = screen.captureTextNow;
  const isCapturingRef = useRef(screen.isCapturing);
  isCapturingRef.current = screen.isCapturing;
  // Ref for the ring buffer so triggerAI can filter by freshness (Req 8.1, 8.2)
  const recentOcrResultsRef = useRef(screen.recentOcrResults);
  recentOcrResultsRef.current = screen.recentOcrResults;
  const sendScreenKeyframeRef = useRef(sendScreenKeyframe);
  sendScreenKeyframeRef.current = sendScreenKeyframe;
  // Ref for the latest frame hash so triggerAI can key screen-aware cache lookups (Req 6.1)
  const latestFrameHashRef = useRef(screen.latestFrameHash);
  latestFrameHashRef.current = screen.latestFrameHash;
  // Ref to hold the latest triggerAI so effects can call it without depending on it
  const triggerAIRef = useRef<(query?: string) => Promise<void>>(async () => {});
  // Phone Camera Input: when set, triggerAI uses this as keyframeForContext
  // instead of screen capture. Cleared after consumption.
  const phoneImageRef = useRef<{ base64: string; mimeType: string } | null>(null);
  // Set for exactly one dispatch after a `NoVisionProviderError`: the pixel path
  // captured the screen but nothing configured can read pixels, so the retry has
  // to go the slow text way (UI Automation / OCR) instead of capturing pixels
  // again and failing identically. Cleared at the top of the dispatch that reads
  // it, which is what makes the fallback single-shot rather than a loop.
  const forceTextChainRef = useRef(false);
  const inputTextRef = useRef(inputText);
  inputTextRef.current = inputText;

  // Phone Camera Input: listen for photos sent from the phone browser
  useEffect(() => {
    if (!isElectronEnv || !electronAPI?.onPhoneImage) return;

    const cleanup = electronAPI.onPhoneImage((data) => {
      console.log('[FloatingCopilot] Received photo from phone:', data.mimeType);
      phoneImageRef.current = data;
      setLastPhoneImageTime(Date.now());

      // Auto-dismiss the QR code modal so the user immediately sees the streaming answer
      setPhoneModalOpen(false);

      // Auto-expand the overlay to maximized mode (480x680) so the middle answer area is fully visible
      if (setOverlayMode) {
        setOverlayMode('maximized');
      }
      setIsHidden(false);

      // Append user message to chat history
      const query = inputTextRef.current.trim() || 'Answer the question in this photo';
      setChatHistory((prev) => [
        ...prev,
        { id: generateId(), role: 'user', text: query },
      ]);
      if (inputTextRef.current.trim()) {
        setInputText('');
      }

      // Arm screen keyframe flag so triggerAI includes image context
      sendScreenKeyframeRef.current = true;

      // Fire AI request immediately
      void triggerAIRef.current(query);
    });

    return cleanup;
  }, [isElectronEnv, electronAPI, setOverlayMode]);

  // Timer & Duration Limit Check
  useEffect(() => {
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setElapsedTime(elapsed);

      // Check meeting duration limit
      if (elapsed > 0 && elapsed % 60 === 0) { // check every minute
        const maxMins = limits.meetingDurationMinutes;
        if (Number.isFinite(maxMins) && Math.floor(elapsed / 60) >= maxMins) {
          setUpgradeModal({ reason: 'meeting-limit' });
          // Stop captures
          // Cannot call speech.pause() safely here because of missing deps,
          // but we can set a flag or just let the modal block interactions.
          // Let's use handlePanicHide equivalent if we want, but wait, the easiest is to just show the modal.
          // When the modal shows, user has to close it. But they can keep the meeting running?
          // We can dispatch a custom event to trigger pause.
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [limits.meetingDurationMinutes]);

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
      isDetached: false,
      transcript: mergedTranscript,
      interimText: speech.interimText,
      streamingText,
      aiResponse,
      isLoading,
      isStreaming,
      elapsedTime,
      coaching,
      activeMode,
    });
  }, [mergedTranscript, speech.interimText, streamingText, aiResponse, isLoading, isStreaming, elapsedTime, coaching, activeMode, broadcastState]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [mergedTranscript]);

  // Auto-scroll chat to latest message
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, streamingText]);

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
      // Resume: show overlay, resume mic, but do NOT auto-restart screen
      // capture OR system-audio capture (parity with screen — the user
      // re-enables system audio manually via the headphones toggle).
      setIsHidden(false);
      setIsPanicHidden(false);
      speech.resume();
    } else {
      // Panic: hide overlay, mute mic + system audio, stop capture, pause AI
      setIsHidden(true);
      setIsPanicHidden(true);
      speech.pause();
      systemAudio.pause();
      if (screen.isCapturing) {
        screen.stopCapture();
      }
      // Abort any in-flight AI request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    }
  }, [isPanicHidden, speech, systemAudio, screen]);

  // Handle coaching and simulated response updates
  useEffect(() => {
    if (mergedTranscript.length === 0) return;
    const fullText = mergedTranscript.map(l => l.text).join(' ');
    const totalWords = fullText.split(/\s+/).length;
    const analysis = getFullAnalysis(fullText, totalWords, elapsedTime);
    setCoaching(analysis);
  }, [mergedTranscript, elapsedTime]);

  // Autonomous question detection
  // Req 12.5: Call triggerAIRef.current() so this effect does NOT depend on triggerAI
  useEffect(() => {
    if (isPanicHidden) return; // Paused during panic hide (Requirement 15.8)
    if (mergedTranscript.length > 0) {
      const recentContext = mergedTranscript.slice(-3); // Get last 3 lines for context
      questionDetectorRef.current.onNewContext(recentContext, async (result) => {
        // Suppress duplicate triggers while AI is already working
        if (isStreamingRef.current || isLoadingRef.current) return;
        // Show detected question badge
        setDetectedQuestion(result.question.length > 80 ? result.question.slice(0, 80) + '…' : result.question);
        setTimeout(() => setDetectedQuestion(null), 3500);
        // Auto-expand overlay so the answer is visible
        if (isNativeOverlay && (overlayModeRef.current === 'compact' || overlayModeRef.current === 'expanded')) {
          setOverlayMode('maximized');
        }
        await triggerAIRef.current();
      });
    }
  }, [mergedTranscript, isPanicHidden, isNativeOverlay, setOverlayMode]);

  // Predictive pre-warming detection (user mic interim)
  // Req 12.5: Call triggerAIRef.current() so this effect does NOT depend on triggerAI
  useEffect(() => {
    if (isPanicHidden) return; // Paused during panic hide (Requirement 15.8)
    if (speech.interimText) {
      questionDetectorRef.current.onInterimText(speech.interimText, async () => {
        if (isStreamingRef.current || isLoadingRef.current) return;
        await triggerAIRef.current(speech.interimText);
      });
    }
  }, [speech.interimText, isPanicHidden]);

  // System-audio interim text — feed the other party's live text into
  // the question detector so detection can fire mid-utterance when
  // Whisper emits partial results (future improvement).
  useEffect(() => {
    if (isPanicHidden) return;
    const interim = systemAudio.interimText;
    // Whisper currently emits '...' as interim — skip that placeholder.
    if (interim && interim !== '...' && interim.trim().length > 10) {
      questionDetectorRef.current.onInterimText(interim, async () => {
        if (isStreamingRef.current || isLoadingRef.current) return;
        setDetectedQuestion(interim.length > 80 ? interim.slice(0, 80) + '…' : interim);
        setTimeout(() => setDetectedQuestion(null), 3500);
        if (isNativeOverlay && (overlayModeRef.current === 'compact' || overlayModeRef.current === 'expanded')) {
          setOverlayMode('maximized');
        }
        await triggerAIRef.current(interim);
      });
    }
  }, [systemAudio.interimText, isPanicHidden, isNativeOverlay, setOverlayMode]);

  // Mic does NOT auto-start. User must explicitly enable transcription
  // via the headphone/mic toggle button on the control capsule.
  // Previously this auto-started on mount which caused unwanted live
  // transcription appearing in the overlay immediately.

  // Bug Fix #1: triggerAI uses isStreamingRef instead of stale isStreaming closure
  // Req 12.2: Manual-override abort — abort in-flight request, discard late tokens via requestId
  // Req 12.5: useCallback with only stable deps (refs for transcript/screenText/activeMode)
  const activeModeRef = useRef(activeMode);
  activeModeRef.current = activeMode;
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;
  const customModesRef = useRef(customModes);
  customModesRef.current = customModes;

  // --- Dispatch warm-up ---------------------------------------------------
  //
  // Move the one-time setup costs that used to land on the first question into
  // idle time after mount:
  //
  //   * `warmProviders` reads the saved provider list from IndexedDB, decrypts
  //     each stored key through the keystore, and dynamically imports the
  //     selected adapter chunk. Left lazy inside `streamAIResponse`, all of that
  //     sits between the click and the request actually leaving.
  //   * `primeFastContext` memoizes the User's redaction rules, which is the
  //     only await left in the fast context builder.
  //
  // Both are idempotent and swallow their own failures, so a warm-up that
  // doesn't complete just leaves the original lazy path in place.
  useEffect(() => {
    let cancelled = false;
    const warm = () => {
      if (cancelled) return;
      void primeFastContext();
      void warmProviders(apiKeyRef.current);
    };
    // requestIdleCallback where available, so warm-up never competes with the
    // overlay's first paint.
    const idle = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof idle === 'function') {
      idle(warm, { timeout: 2000 });
    } else {
      setTimeout(warm, 250);
    }
    return () => { cancelled = true; };
  }, []);

  // Helper: race a promise against a timeout. If the promise doesn't resolve
  // within `ms`, resolves with `fallback` instead of blocking the UI thread.
  // This prevents IPC calls (UIA, BitBlt) from hanging the overlay when the
  // window is hidden or Windows focus is unstable.
  const raceTimeout = useCallback(<T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
  }, []);

  // --- Latency budget for the dispatch path -------------------------------
  //
  // See the module-level constants above.

  const triggerAI = useCallback(async (query?: string) => {
    // Enforce AI response limit
    if (isLimitReached('aiResponsesPerDay')) {
      setUpgradeModal({ reason: 'ai-response-limit' });
      return;
    }

    // Guard: if a previous triggerAI is still in its capture/dispatch phase
    // (not yet streaming), skip this call. Rapid "Use Screen" clicks should
    // not stack up multiple concurrent IPC calls that overwhelm the main process.
    // Once streaming starts, isLoadingRef flips to false and new calls are allowed.
    if (isLoadingRef.current && !isStreamingRef.current) {
      console.log('[FloatingCopilot] triggerAI skipped: previous dispatch still in flight');
      return;
    }

    setIsLoading(true);
    isLoadingRef.current = true;
    setIsStreaming(false);
    isStreamingRef.current = false;

    // Track dispatch start time for screen.dispatch telemetry (Req 9.1)
    const dispatchStartMs = performance.now();
    const sw = makeStopwatch('triggerAI');

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
    setReasoningText('');

    // Read outside the `try` so the catch can tell a first attempt from the
    // text-chain retry it scheduled, and therefore cannot loop on it.
    const forceTextChain = forceTextChainRef.current;
    forceTextChainRef.current = false;

    try {
      // Read current values from refs (Req 12.5: stable deps)
      const currentTranscript = transcriptRef.current;
      const currentActiveMode = activeModeRef.current;
      const currentApiKey = apiKeyRef.current;
      const currentCustomModes = customModesRef.current;

      // Use the freshest available Screen_Text at dispatch time (Req 1.4).
      // The periodic OCR loop (every 3 s) keeps screenTextRef updated. We do
      // NOT await a new OCR pass here — that would block the critical dispatch
      // path (violating Req 1.3). Instead we use whatever text is already
      // available and kick off a fire-and-forget OCR pass that will update
      // screenTextRef for the NEXT request.
      const screenArmed = sendScreenKeyframeRef.current;
      let currentScreenText = screenTextRef.current;

      // Vision routing (Req 2.1, 2.2, 2.3, 2.4):
      // - A vision provider is reachable → send pixels, skip text extraction
      // - No vision provider → obtain Screen_Text via UIA/OCR
      //
      // `isVisionAdapter` asks only about the *first* adapter in priority order;
      // `hasVisionProvider` asks whether *any* usable adapter accepts images. The
      // second is the question that matters when deciding to capture pixels,
      // because the dispatch below sets `requireImageInput` and the router then
      // walks past the text-only adapters to reach the vision one. Using the
      // narrower check is what pushed setups that already had Gemini configured
      // through PowerShell and Tesseract for no reason.
      // Both questions below are answered from the router's adapter list, and
      // that list is populated lazily — by `streamAIResponse`, which runs *after*
      // this point. On the first dispatch of a session the router can still be
      // empty here, and an empty router answers "nothing reads images", which
      // sends a perfectly vision-capable setup down the PowerShell + Tesseract
      // chain and pays ten seconds for text a vision model never needed. Worse,
      // a dispatch that then aborts for want of grounding never reaches the sync
      // either, so the click after it is cold in exactly the same way.
      //
      // `warmProviders` is idempotent and short-circuits on an unchanged config
      // hash, so once warm this is a single IndexedDB read.
      if (screenArmed) {
        await warmProviders(currentApiKey);
        sw.mark('providers');
      }

      const isVisionAdapter = activeAdapterSupportsImageInput();
      const visionAvailable = !forceTextChain && (isVisionAdapter || hasVisionProvider());
      let keyframeForContext: { mimeType: string; base64: string } | null = null;
      let ocrSkippedForVision = false;

      // Phone Camera Input: if a phone image is pending, use it directly
      // as the keyframe and skip all screen capture paths.
      if (phoneImageRef.current) {
        const pending = phoneImageRef.current;
        phoneImageRef.current = null; // consume once
        ocrSkippedForVision = true;
        currentScreenText = '';

        if (visionAvailable) {
          keyframeForContext = pending;
        } else {
          // A text-only model cannot read the photo, and the adapter drops it
          // before the request goes out — so passing it through produces a prompt
          // with nothing in it. OCR is the only way this capture reaches the model.
          const photoText = await raceTimeout(
            ocrBase64Image(pending.base64, pending.mimeType),
            OCR_TIMEOUT_MS,
            '',
          ).catch(() => '');
          if (photoText.length > 20) {
            currentScreenText = photoText;
            screenTextRef.current = photoText;
            console.log(`[FloatingCopilot] OCR'd pending image into ${photoText.length} chars for text-only model`);
          } else {
            console.warn('[FloatingCopilot] Pending image had no legible text for a text-only model');
          }
        }
      } else if (screenArmed) {
        // Determine if this call originated from handleUseScreen (first click)
        // which already prefetched fresh context, vs a subsequent user query
        // (e.g. typing "next") that needs a NEW capture of the current screen.
        const calledFromUseScreenButton = useScreenPendingRef.current;
        const alreadyHasContext = calledFromUseScreenButton && currentScreenText && currentScreenText.length > 20;

        if (!visionAvailable) {
          // Why the slow chain is about to run. The text chain costs a PowerShell
          // spawn plus a Tesseract pass — 10 s and up on this machine — so when
          // it runs despite a vision model being configured, that has to be
          // visible rather than inferred from the absence of a log line.
          // eslint-disable-next-line no-console
          console.log(
            `[FloatingCopilot] Text chain: forceTextChain=${forceTextChain} activeAdapterVision=${isVisionAdapter} anyVisionAdapter=${hasVisionProvider()}`,
          );
        }

        // Set when the native capture reports the foreground window is excluded
        // from capture (`WDA_MONITOR` / `WDA_EXCLUDEFROMCAPTURE`). Every pixel
        // source is then a dead end — BitBlt reads the window behind the protected
        // one and getDisplayMedia blacks it out — so the flag exists to stop a
        // later pixel attempt from succeeding with the wrong screen. Declared out
        // here because the text chain below needs it too.
        let captureProtected = false;

        if (visionAvailable) {
          // ---- PIXEL PATH ----------------------------------------------------
          // A vision model can read the screen directly, which makes every text
          // extraction step on this path pure overhead. BitBlt is a native
          // GetDC(NULL) + BitBlt through koffi — tens of milliseconds — whereas
          // UI Automation spawns powershell.exe and walks the accessibility tree,
          // and Tesseract is seconds. So when pixels are acceptable to the model,
          // capture pixels and stop.
          //
          // This also removes the reason the old chain preferred text: it was
          // guarding against a text-only model 404-ing on an image. `dispatch`
          // below passes `requireImageInput`, so the router skips text-only
          // adapters instead of failing on them, and the guard is unnecessary.
          if (alreadyHasContext) {
            ocrSkippedForVision = true;
            console.log(`[FloatingCopilot] Using prefetched screen text (${currentScreenText.length} chars)`);
          } else if (typeof window !== 'undefined' && window.electronAPI?.captureDesktopBitBlt) {
            const bitblt = await raceTimeout(
              window.electronAPI.captureDesktopBitBlt(),
              BITBLT_TIMEOUT_MS,
              { ok: false } as BitBltResult,
            ).catch(() => ({ ok: false } as BitBltResult));

            if (bitblt.ok && bitblt.base64) {
              keyframeForContext = { mimeType: 'image/jpeg', base64: bitblt.base64 };
              ocrSkippedForVision = true;
              currentScreenText = '';
              telemetry.emit({ kind: 'screen.ocrSkipped', reason: 'vision-adapter' });
              if (bitblt.bytes) {
                sw.note(`shot ${Math.round(bitblt.bytes / 1024)}KB ${bitblt.width}x${bitblt.height}`);
              }
              console.log('[FloatingCopilot] BitBlt → vision model (no OCR, no UIA)');
            } else if (bitblt.reason === 'capture-protected') {
              // Not a failure — a refusal, and the only correct one. The pixels of
              // a protected window are unreadable by every capture API available
              // here, and the previous behaviour was to hand the model a valid JPEG
              // of whatever sat behind it and answer fast and wrong.
              captureProtected = true;
              sw.note('capture-protected');
              // eslint-disable-next-line no-console
              console.log(
                '[FloatingCopilot] Foreground window is capture-protected — UI Automation is the only path to its text',
              );
            } else {
              // The pixel path failing silently is what sends a vision-capable
              // setup down the 10-second text chain, so name the cause. A blank
              // `reason` means `raceTimeout` won — the capture overran
              // BITBLT_TIMEOUT_MS rather than reporting an error.
              // eslint-disable-next-line no-console
              console.warn(
                `[FloatingCopilot] BitBlt returned no pixels (${bitblt.reason ?? `timeout >${BITBLT_TIMEOUT_MS}ms`}) — falling through to the text chain`,
              );
            }
          }

          // getDisplayMedia keyframe — the web-mode equivalent of BitBlt, and the
          // fallback when the native module is unavailable.
          //
          // Skipped outright on a protected window: display affinity was designed
          // to defeat exactly this API, so it returns a frame with the window
          // blacked out. That frame is not empty, so it would satisfy the check
          // below and suppress the text chain — trading a working UI Automation
          // read for a picture of a black rectangle.
          if (!keyframeForContext && !ocrSkippedForVision && !captureProtected) {
            try {
              const keyframeResult = await getKeyframeAsyncRef.current();
              if (keyframeResult) {
                keyframeForContext = { mimeType: 'image/jpeg', base64: keyframeResult.base64 };
                ocrSkippedForVision = true;
                currentScreenText = '';
                telemetry.emit({ kind: 'screen.ocrSkipped', reason: 'vision-adapter' });
              }
            } catch { /* fall through to the text chain */ }
          }
        }

        // ---- TEXT CHAIN ------------------------------------------------------
        // Reached when no vision provider is configured, or when every pixel
        // capture above failed. Shared by both cases rather than duplicated per
        // adapter kind: the steps and their order are identical, only the reason
        // for being here differs.
        if (!keyframeForContext && !ocrSkippedForVision) {
          // UI Automation is the only source that survives
          // SetWindowDisplayAffinity, so it stays first despite being the
          // slowest — on a protected window the alternatives return nothing.
          if (
            !alreadyHasContext
            && typeof window !== 'undefined'
            && window.electronAPI?.extractForegroundText
          ) {
            try {
              const uia = await raceTimeout(
                window.electronAPI.extractForegroundText(),
                captureProtected ? UIA_PROTECTED_TIMEOUT_MS : UIA_TIMEOUT_MS,
                { ok: false, text: '' },
              );
              if (uia.ok && uia.text && uia.text.length > 20) {
                currentScreenText = uia.text;
                screenTextRef.current = uia.text;
                console.log(`[FloatingCopilot] UI Automation got ${uia.text.length} chars`);
              }
            } catch { /* fall through to OCR */ }
          }

          // OCR the live getDisplayMedia frame.
          //
          // Skipped on a protected window. Display affinity blanks this API by
          // design, so Tesseract would be run for its full timeout against a black
          // rectangle — seconds spent to learn nothing, on the one path where the
          // remaining time matters most.
          if ((!currentScreenText || currentScreenText.length <= 20) && !captureProtected) {
            const fresh = await raceTimeout(captureTextNowRef.current(), OCR_TIMEOUT_MS, '');
            if (fresh) {
              currentScreenText = fresh;
              screenTextRef.current = fresh;
            }
          }

          // Last resort: BitBlt, then OCR the frame it returns.
          //
          // `captureTextNow` OCRs the `getDisplayMedia` video frame, so it returns
          // '' whenever that stream is unavailable. BitBlt reaches pixels that API
          // cannot — a window on a display it was not granted, for one.
          //
          // It does not reach a capture-protected window: the native side refuses
          // and returns `capture-protected`, so this block costs one IPC round trip
          // and stops. Left unguarded deliberately, because the refusal belongs in
          // one place rather than being restated at every call site.
          if (
            (!currentScreenText || currentScreenText.length <= 20)
            && typeof window !== 'undefined'
            && window.electronAPI?.captureDesktopBitBlt
          ) {
            const bitblt = await raceTimeout(
              window.electronAPI.captureDesktopBitBlt(),
              BITBLT_TIMEOUT_MS,
              { ok: false } as BitBltResult,
            ).catch(() => ({ ok: false } as BitBltResult));

            if (bitblt.ok && bitblt.base64) {
              const shotText = await raceTimeout(
                ocrBase64Image(bitblt.base64),
                OCR_TIMEOUT_MS,
                '',
              ).catch(() => '');
              if (shotText.length > 20) {
                currentScreenText = shotText;
                screenTextRef.current = shotText;
                console.log(`[FloatingCopilot] BitBlt+OCR got ${shotText.length} chars`);
              }
            }
          }
        }
      }
      sw.mark('capture');

      // Is this a screen-grounded dispatch? When it is, the question itself is
      // in the captured pixels or UI text, and the fast path applies: an exact
      // hash cache instead of an embedding-similarity one, and a context window
      // assembled without Knowledge_Base or Memory_Store retrieval. Both of
      // those otherwise run Transformers.js forward passes on the
      // single-threaded WASM backend, which is where the bulk of the old
      // click-to-first-token time went.
      //
      // Gated on the button being armed, NOT on grounding having materialised.
      // The reverse — requiring real screen text or a keyframe — reads as the
      // more careful choice, on the reasoning that a capture which came back
      // empty is exactly when retrieval has something left to contribute. That
      // reasoning is wrong here, because it prices retrieval at the deadline
      // (600 ms) rather than at what it actually costs. Embeddings run on the
      // renderer main thread and cannot be preempted by the deadline, so the
      // true cost is seconds — and it buys Knowledge_Base hits for a question
      // the model cannot see, which is not an answer the User can use anyway.
      // Routing failed captures into the slowest path produced the observed
      // 20–60 s dispatch that still replied "no conversation context".
      //
      // `hasScreenGrounding` is kept for the cache key and telemetry below: a
      // dispatch with nothing captured must not be stored under, or served from,
      // a key that claims a screen.
      //
      // A keyframe only counts when *some* reachable adapter can read it. A
      // text-only model has its images stripped before the request is sent, so an
      // image-only capture is indistinguishable from no capture at all from the
      // model's side — counting it as grounding is what let an empty prompt reach
      // the provider and come back as "no conversation context was included".
      // With `requireImageInput` set on the dispatch the router routes past those
      // adapters, so the question is `visionAvailable`, not "is the first one".
      const hasScreenGrounding =
        (currentScreenText ? currentScreenText.trim().length >= 24 : false)
        || (keyframeForContext !== null && visionAvailable);
      const useFastPath = screenArmed || hasScreenGrounding;

      // Determine the core query for caching purposes
      const coreQuery = query || (currentTranscript.length > 0 ? currentTranscript[currentTranscript.length - 1].text : '');

      // A screen dispatch with nothing captured and nothing typed cannot succeed.
      // There is no question in the prompt — not a vague one, none — so the round
      // trip can only come back as the model reporting an empty context, after the
      // User has already waited out the whole capture chain. Say so directly
      // instead, and keep the armed state so the next attempt is one click.
      if (screenArmed && !hasScreenGrounding && !coreQuery.trim()) {
        console.warn('[FloatingCopilot] Screen dispatch aborted: no capture and no query');
        sw.report('aborted — no grounding');
        setChatHistory(prev => [...prev, {
          id: generateId(),
          role: 'assistant',
          text: 'Could not read the screen. Make sure the target window is visible and in front, then try again.',
        }]);
        setIsLoading(false);
        isLoadingRef.current = false;
        setIsStreaming(false);
        isStreamingRef.current = false;
        return;
      }

      const applyCachedAnswer = (text: string, isSimulated: boolean): boolean => {
        // Only apply if this request is still current
        if (requestIdRef.current !== currentRequestId) return true;
        setAiResponse({ text, suggestions: [], followUps: [], isSimulated });
        setChatHistory(prev => [...prev, { id: generateId(), role: 'assistant', text, isSimulated }]);
        setIsLoading(false);
        isLoadingRef.current = false;
        setIsStreaming(false);
        isStreamingRef.current = false;
        setAiSuggestionCount(prev => prev + 1);
        return true;
      };

      // Resolve the frame hash for screen-aware cache keying (Req 6.1).
      // The latestFrameHashRef is updated every time getKeyframeAsync runs
      // (which already happened above for the vision path). For text-only
      // adapters it holds the hash from the most recent periodic frame prep.
      const currentFrameHash: Uint8Array | null = screenArmed
        ? latestFrameHashRef.current
        : null;

      // Fast-path cache lookup: synchronous, exact-match on
      // mode + query + screen text + image. No embedding, so a miss costs
      // effectively nothing (Req 6.1, 6.2 in spirit — same "unchanged screen
      // answers instantly" guarantee, without the WASM round trip).
      //
      // Keyed off `hasScreenGrounding`, not `useFastPath`. When capture came back
      // empty the only key material left is the typed query, and that key is not
      // safe: two dispatches of "next" against two different questions, both with
      // a failed capture, hash identically and the second would be served the
      // first one's answer. No grounding, no caching.
      const fastKey = hasScreenGrounding
        ? screenCacheKey({
            mode: currentActiveMode,
            query: coreQuery,
            screenText: currentScreenText || '',
            imageBase64: keyframeForContext?.base64 ?? null,
          })
        : null;

      if (fastKey) {
        const cached = getScreenCached(fastKey);
        if (cached) {
          console.log('[FloatingCopilot] screen fast-cache hit');
          sw.report('fast-cache hit');
          applyCachedAnswer(cached.text, cached.isSimulated);
          return;
        }
      }

      // Embedding-backed Semantic Cache — conversational path only.
      //
      // Skipped entirely when the fast path is active: the exact-match probe
      // above already covers the repeated-question case, and generating a query
      // embedding here would cost more than the lookup can ever save.
      if (coreQuery && !useFastPath) {
        const { hit } = await raceTimeout(
          semanticCache.get(coreQuery),
          SEMANTIC_CACHE_DEADLINE_MS,
          { hit: null, similarity: 0 },
        ).catch(() => ({ hit: null, similarity: 0 }));
        if (hit) {
          console.log('Semantic cache hit for:', coreQuery);
          sw.report('semantic-cache hit');
          applyCachedAnswer(hit.text, hit.isSimulated);
          return;
        }
      }
      sw.mark('cache');

      const contextImages = keyframeForContext
        ? { images: [keyframeForContext] }
        : (!ocrSkippedForVision && sendScreenKeyframeRef.current && visionAvailable
            ? (() => {
                const base64 = getKeyframeBase64Ref.current();
                return base64
                  ? { images: [{ mimeType: 'image/jpeg', base64 }] }
                  : undefined;
              })()
            : undefined);

      // The prompt's only grounding is the image when nothing textual survived the
      // capture chain. Telling the router that turns a guaranteed non-answer into
      // either an answer or a diagnosable error: without it the image is handed to
      // whichever adapter is first in priority order, a text-only one drops it, and
      // the model is asked a question with no question in it.
      const imageIsOnlyGrounding =
        (contextImages?.images?.length ?? 0) > 0
        && (currentScreenText ? currentScreenText.trim().length < 24 : true);

      const context = useFastPath
        ? await buildMinimalScreenContext(
            currentActiveMode,
            toLegacyTranscript(currentTranscript),
            currentScreenText,
            query || '',
            currentCustomModes,
            contextImages,
          )
        : await buildContextWindow(
            currentActiveMode,
            toLegacyTranscript(currentTranscript),
            currentScreenText,
            query || '',
            currentCustomModes,
            // Vision adapter with successful keyframe: use the already-captured
            // keyframe (Req 2.1). Text_Only_Adapter or keyframe failure: no
            // image attachment. Legacy path: synchronous keyframe when the
            // adapter supports images but the new path is not active.
            { ...contextImages, retrievalDeadlineMs: RETRIEVAL_DEADLINE_MS },
          );
      sw.mark('context');

      // Check if this request is still current after async context build
      if (requestIdRef.current !== currentRequestId) return;

      // Store modalities and citations from the context window (Requirement 23.4, 5.5)
      if (context.modalitiesUsed) {
        setModalitiesUsed(context.modalitiesUsed);
      }
      if (context.citations) {
        setCitations(context.citations);
      }

      // Emit screen.dispatch telemetry when screen context is armed (Req 9.1)
      if (screenArmed) {
        telemetry.emit({
          kind: 'screen.dispatch',
          latencyMs: Math.round(performance.now() - dispatchStartMs),
          hasKeyframe: keyframeForContext !== null,
          hasScreenText: currentScreenText !== '' && currentScreenText !== null,
        });
      }

      await streamAIResponse(
        context,
        {
          onToken: (partialText) => {
            // Discard late tokens: only update state if requestId matches (Req 12.2)
            if (requestIdRef.current !== currentRequestId) return;
             if (!isStreamingRef.current) {
              sw.mark('ttft');
              sw.report(useFastPath ? 'fast path' : 'full path');
              setIsLoading(false);
              isLoadingRef.current = false;
              setIsStreaming(true);
              isStreamingRef.current = true;
            }
            setStreamingText(partialText);
          },
          onReasoning: (cumulativeReasoning) => {
            if (requestIdRef.current !== currentRequestId) return;
            // Deliberately does NOT flip `isStreaming`/`isLoading`: the answer
            // has not started, and treating reasoning as the answer would make
            // `onToken`'s first-token bookkeeping — and the `ttft` mark — lie.
            // The reasoning phase gets its own indicator instead.
            setReasoningText(cumulativeReasoning);
          },
          onComplete: (response) => {
            // Discard completion from aborted stream (Req 12.2)
            if (requestIdRef.current !== currentRequestId) return;
            // Save to cache if it was a good response.
            if (!response.isSimulated && response.text.trim()) {
              if (useFastPath) {
                // Exact-hash store, mirroring the exact-hash lookup above. Costs
                // nothing and makes a re-ask about an unchanged screen instant.
                setScreenCached(fastKey, {
                  text: response.text,
                  isSimulated: response.isSimulated,
                });
                // Also populate the embedding-backed screen cache, but off the
                // critical path — the answer is already on screen, so this only
                // needs to be ready for some *later* request.
                if (coreQuery && currentFrameHash) {
                  void semanticCache.setWithFrame(
                    { query: coreQuery, frameHash: currentFrameHash },
                    {
                      text: response.text,
                      isSimulated: response.isSimulated,
                      status: (response as any).status ?? 200,
                    },
                  ).catch(() => undefined);
                }
              } else if (coreQuery) {
                void semanticCache.set(coreQuery, {
                  text: response.text,
                  isSimulated: response.isSimulated,
                  status: (response as any).status ?? 200,
                });
              }
            }
            setAiResponse(response);
            // Append assistant message to chat history
            setChatHistory(prev => [...prev, { id: generateId(), role: 'assistant', text: response.text, isSimulated: response.isSimulated }]);
            setStreamingText('');
            setReasoningText('');
            setIsStreaming(false);
            isStreamingRef.current = false;
            isLoadingRef.current = false;
            setAiSuggestionCount(prev => prev + 1);

            // Increment usage limit after a successful generation (not simulated)
            if (!response.isSimulated) {
              incrementUsage('aiResponseCount');
            }
          },
          onMetrics: (metrics) => {
            // Which model actually answered. `onComplete`'s `AIResponse` does not
            // carry it, and the `[perf]` line in `onToken` fires before the router
            // has resolved anything — so without this, a latency number is
            // unattributable: "3s" means nothing until you know whether it came
            // from the fast slot or from the thinking model.
            //
            // `totalLatency` is the adapter's own measurement of the request;
            // `sw.elapsed()` is the wall clock the User experienced, capture and
            // context assembly included. Both, because the gap between them is
            // the part this app is responsible for.
            // eslint-disable-next-line no-console
            console.log(
              `[perf] answered by ${metrics.model} — ttft ${Math.round(metrics.timeToFirstToken)}ms | provider ${Math.round(metrics.totalLatency)}ms | wall ${sw.elapsed()}ms`,
            );
          },
          onProviderFallback: (error) => {
            // Every real provider failed and simulation is about to answer.
            // Name the actual cause — the generic "add your Gemini key" banner
            // on the simulated reply misattributes wrong-model / no-credit /
            // model-disabled failures to a missing credential.
            if (requestIdRef.current !== currentRequestId) return;
            toast.error(`AI provider unavailable: ${describeProviderFailure(error)}`, {
              duration: 7000,
            });
          },
          onError: (error) => {
            if (error.name === 'AbortError') {
              // Reset loading state on abort so buttons don't get stuck
              setIsLoading(false);
              isLoadingRef.current = false;
              setIsStreaming(false);
              isStreamingRef.current = false;
              return;
            }
            // Discard errors from stale requests
            if (requestIdRef.current !== currentRequestId) return;
            toast.error('AI streaming encountered an error. Please try again.');
            setIsStreaming(false);
            isStreamingRef.current = false;
            setIsLoading(false);
            isLoadingRef.current = false;
            setAiResponse({
              text: 'Sorry, I encountered an error generating a response. Please try again.',
              suggestions: [],
              followUps: [],
              isSimulated: true,
            });
          },
        },
        currentApiKey,
        abortControllerRef.current.signal,
        {
          requireImageInput: imageIsOnlyGrounding,
          // A screen dispatch is the latency-critical case: the question is on
          // screen right now, in front of someone waiting. Ask for the fast model.
          // Degrades to today's behaviour when the provider has none configured, so
          // this is safe to set always.
          preferFastModel: useFastPath,
          // 'low' rather than 'none', and the distinction is the whole point of
          // answer-first output.
          //
          // With deliberation switched off entirely, the directive to lead with the
          // answer makes the model commit to a letter before it has computed
          // anything, then do the arithmetic in the visible text and discover it was
          // wrong. Measured on a protected-window MCQ: first line "B) 2", corrected
          // to "A) 1" three paragraphs down. First token at 804ms, and worthless —
          // in an interview the first line is the one that gets said out loud.
          //
          // A small budget buys the check before the commit. It is not free, but the
          // thing being paid for is the first line meaning what it says, and there is
          // room for it: 804ms of an 8.4s answer.
          reasoningEffort: useFastPath ? 'low' : undefined,
        }
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // Reset loading state on abort so buttons don't get stuck
        setIsLoading(false);
        isLoadingRef.current = false;
        setIsStreaming(false);
        isStreamingRef.current = false;
        return;
      }
      // Discard errors from stale requests
      if (requestIdRef.current !== currentRequestId) return;

      // The screen was captured as pixels but nothing can read pixels. This is a
      // configuration gap, not a transport failure, so retrying the same way is
      // pointless. Retry once down the text chain — UI Automation and OCR are
      // slow, but slow and answered beats fast and wrong — and only report the
      // gap if that pass also comes back with nothing.
      if (error instanceof NoVisionProviderError) {
        sw.report('no vision provider — retrying via text');
        setIsStreaming(false);
        isStreamingRef.current = false;
        setIsLoading(false);
        isLoadingRef.current = false;
        if (!forceTextChain) {
          console.warn('[FloatingCopilot] No image-capable provider — falling back to the text chain');
          forceTextChainRef.current = true;
          // Force a genuine re-capture. `screenTextRef` can still hold text from
          // an earlier question — the pixel path only cleared its local copy — and
          // `useScreenPendingRef` would let the retry treat that as "already have
          // context", answering the previous question instead of this one.
          screenTextRef.current = '';
          useScreenPendingRef.current = false;
          void triggerAIRef.current?.(query);
          return;
        }
        const msg = 'I captured the screen as an image, but none of your configured models can read images, and reading it as text did not work either. Add a vision provider (Gemini or OpenAI) in Settings → AI Providers, or bring the target window to the front and try again.';
        setChatHistory(prev => [...prev, { id: generateId(), role: 'assistant', text: msg }]);
        setAiResponse({ text: msg, suggestions: [], followUps: [], isSimulated: true });
        toast.error('No image-capable model configured', { duration: 7000 });
        return;
      }

      toast.error('AI generation failed. Please try again.');
      setIsStreaming(false);
      isStreamingRef.current = false;
      setIsLoading(false);
      isLoadingRef.current = false;
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
      // Append user message to chat history
      setChatHistory(prev => [...prev, { id: generateId(), role: 'user', text: q }]);
      // Auto-grow the overlay when asking a question (Cluely parity).
      if (isNativeOverlay && overlayModeRef.current === 'expanded') {
        setOverlayMode('maximized');
      }
      triggerAIRef.current(q);
      setInputText('');
    } else {
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
  //
  // FIX: On the first click, we now await fresh screen context BEFORE
  // dispatching to the AI. The old code fired triggerAI immediately while
  // getDisplayMedia was still pending, which meant the AI received empty
  // context and answered "I'm ready to help" or "no question found."
  const useScreenPendingRef = useRef(false);
  const handleUseScreen = useCallback(async () => {
    // Debounce: ignore repeated clicks while a request is in flight.
    // Safety: if pending was stuck (IPC hung), force-reset it
    // so the button doesn't stay permanently unresponsive.
    if (useScreenPendingRef.current) {
      // If AI is no longer loading/streaming, the pending flag is stale — reset it
      if (!isLoadingRef.current && !isStreamingRef.current) {
        useScreenPendingRef.current = false;
      } else {
        return;
      }
    }

    try {
      const isActive = screen.isCapturing && sendScreenKeyframeRef.current;
      if (isActive) {
        // Toggle OFF
        screen.stopCapture();
        sendScreenKeyframeRef.current = false;
        setSendScreenKeyframe(false);
        void knowledgeBase.setSetting('sendScreenKeyframe', false);
        return;
      }

      // If screen is already armed but getDisplayMedia isn't capturing
      // (e.g. on Electron where BitBlt/UIA is used instead), clicking again
      // means "re-capture the current screen and ask AI". Don't redo the
      // full prefetch — just dispatch triggerAI which handles fresh capture.
      if (sendScreenKeyframeRef.current) {
        // Skip if AI is already working
        if (isLoadingRef.current || isStreamingRef.current) return;
        const query = inputText.trim();
        const echoed = query || 'Answer the question on my screen';
        setChatHistory(prev => [...prev, { id: generateId(), role: 'user', text: echoed }]);
        if (query) setInputText('');
        if (isNativeOverlay && (overlayModeRef.current === 'compact' || overlayModeRef.current === 'expanded')) {
          setOverlayMode('maximized');
        }
        triggerAIRef.current(query || undefined).catch((err) => {
          if (err?.name !== 'AbortError') {
            console.error('[FloatingCopilot] UseScreen re-trigger failed:', err);
          }
        });
        return;
      }

      // Mark pending immediately for debounce + visual feedback
      useScreenPendingRef.current = true;

      // Toggle ON: arm the flag IMMEDIATELY for instant visual feedback.
      sendScreenKeyframeRef.current = true;
      setSendScreenKeyframe(true);
      void knowledgeBase.setSetting('sendScreenKeyframe', true);

      // Start getDisplayMedia in the background (non-blocking). We don't
      // wait for it because BitBlt/UI Automation are faster fallbacks.
      if (!screen.isCapturing) {
        screen.startCapture().then(() => {
          void warmOcrWorker();
        }).catch(() => {
          console.log('[FloatingCopilot] getDisplayMedia unavailable, using fallback capture');
        });
      }

      // --- PRE-FETCH fresh screen context before calling AI ---
      // This ensures the first click gets real content instead of empty context.
      const prefetchSw = makeStopwatch('useScreen.prefetch');
      let prefetchedText = '';
      let prefetchedImage: { base64: string; mimeType: string } | null = null;

      // Can anything reachable read pixels? If so, that is the whole prefetch:
      // one native BitBlt and dispatch. UI Automation exists to turn a screen into
      // text for models that cannot see, and Tesseract exists as its fallback —
      // both are wasted work in front of a vision model, and both are the reason
      // "Use Screen" took tens of seconds.
      //
      // Synced first for the same reason as in `triggerAI`: this question is
      // answered from the router's adapter list, and on the first click of a
      // session that list has not been populated yet. Asking it cold answers "no"
      // and buys the slow chain.
      await warmProviders(apiKeyRef.current);
      prefetchSw.mark('providers');
      const visionAvailable = activeAdapterSupportsImageInput() || hasVisionProvider();

      // As in `triggerAI`: a protected foreground window makes every pixel source
      // a dead end, and the getDisplayMedia fallback below would otherwise satisfy
      // itself with a blacked-out frame and skip the text chain entirely.
      let captureProtected = false;

      if (visionAvailable && typeof window !== 'undefined' && window.electronAPI?.captureDesktopBitBlt) {
        const bitblt = await raceTimeout(
          window.electronAPI.captureDesktopBitBlt(),
          BITBLT_TIMEOUT_MS,
          { ok: false } as BitBltResult,
        ).catch(() => ({ ok: false } as BitBltResult));

        if (bitblt.ok && bitblt.base64) {
          prefetchedImage = { mimeType: 'image/jpeg', base64: bitblt.base64 };
          console.log('[FloatingCopilot] UseScreen prefetch: BitBlt → vision model');
        } else if (bitblt.reason === 'capture-protected') {
          captureProtected = true;
          console.log('[FloatingCopilot] UseScreen prefetch: window is capture-protected → UI Automation');
        }
        prefetchSw.mark('bitblt-vision');
      }

      if (visionAvailable && !prefetchedImage && !captureProtected && screen.isCapturing) {
        // Native module unavailable (non-Windows, koffi missing). getDisplayMedia
        // reaches everything except display-affinity windows.
        try {
          const kf = await getKeyframeAsyncRef.current();
          if (kf) {
            prefetchedImage = { mimeType: 'image/jpeg', base64: kf.base64 };
            console.log('[FloatingCopilot] UseScreen prefetch: keyframe → vision model');
          }
        } catch { /* fall through to the text chain */ }
      }

      // Text chain — no vision provider configured, or every pixel capture failed.
      if (!prefetchedImage) {
      // UI Automation and BitBlt are started together rather than in sequence.
      //
      // They were sequential because they are *preference*-ordered: UIA text beats
      // an image, so asking for the image only after UIA fails reads as avoiding
      // wasted work. But the work being avoided is a native BitBlt — tens of
      // milliseconds — while the wait it imposes is a PowerShell spawn plus a full
      // accessibility-tree walk. Ordering them made the cheap call wait on the
      // expensive one, so the two costs added instead of overlapping. Preference
      // order is preserved below by which result is *consumed* first, not by which
      // request is issued first.
      const uiaPromise =
        typeof window !== 'undefined' && window.electronAPI?.extractForegroundText
          ? raceTimeout(
              window.electronAPI.extractForegroundText(),
              captureProtected ? UIA_PROTECTED_TIMEOUT_MS : UIA_TIMEOUT_MS,
              { ok: false, text: '' } as { ok: boolean; text?: string },
            ).catch(() => ({ ok: false, text: '' }))
          : Promise.resolve({ ok: false, text: '' } as { ok: boolean; text?: string });

      const bitbltPromise =
        typeof window !== 'undefined' && window.electronAPI?.captureDesktopBitBlt
          ? raceTimeout(
              window.electronAPI.captureDesktopBitBlt(),
              BITBLT_TIMEOUT_MS,
              { ok: false } as BitBltResult,
            ).catch(() => ({ ok: false } as BitBltResult))
          : Promise.resolve({ ok: false } as BitBltResult);

      // Priority 1: UI Automation text (survives SetWindowDisplayAffinity)
      const uia = await uiaPromise;
      if (uia.ok && uia.text && uia.text.length > 20) {
        prefetchedText = uia.text;
        console.log(`[FloatingCopilot] UseScreen prefetch: UI Automation got ${uia.text.length} chars`);
      }
      prefetchSw.mark('uia');

      // Priority 2: the BitBlt image, already in flight
      if (!prefetchedText) {
        const bitblt = await bitbltPromise;
        if (bitblt.ok && bitblt.base64) {
          prefetchedImage = { mimeType: 'image/jpeg', base64: bitblt.base64 };
          console.log('[FloatingCopilot] UseScreen prefetch: BitBlt captured image');
        }
        prefetchSw.mark('bitblt');
      }

      // Priority 3: If getDisplayMedia resolved fast enough, try keyframe.
      // Not on a protected window — display affinity blanks this API by design.
      if (!prefetchedText && !prefetchedImage && !captureProtected && screen.isCapturing) {
        try {
          const kf = await getKeyframeAsyncRef.current();
          if (kf) {
            prefetchedImage = { mimeType: 'image/jpeg', base64: kf.base64 };
            console.log('[FloatingCopilot] UseScreen prefetch: keyframe captured');
          }
        } catch { /* fall through */ }
      }

      // Last resort: OCR the current video frame. Skipped on a protected window,
      // where that frame is a black rectangle and Tesseract would burn its whole
      // timeout confirming it.
      if (!prefetchedText && !prefetchedImage && !captureProtected) {
        try {
          const ocrText = await raceTimeout(captureTextNowRef.current(), OCR_TIMEOUT_MS, '');
          if (ocrText && ocrText.length > 10) {
            prefetchedText = ocrText;
            console.log(`[FloatingCopilot] UseScreen prefetch: OCR got ${ocrText.length} chars`);
          }
        } catch { /* fall through */ }
      }

      // An image is only context if the model can actually see it.
      //
      // Against a text-only adapter it is not merely less useful — it is dropped
      // outright before the request is sent, so a capture that succeeded still
      // reaches the model as an empty prompt and comes back as "no conversation
      // context was included". OCR the frame instead: slower than sending pixels,
      // but it is the difference between an answer and no answer.
      if (prefetchedImage && !prefetchedText && !visionAvailable) {
        const imageText = await raceTimeout(
          ocrBase64Image(prefetchedImage.base64, prefetchedImage.mimeType),
          OCR_TIMEOUT_MS,
          '',
        ).catch(() => '');
        if (imageText.length > 20) {
          prefetchedText = imageText;
          prefetchedImage = null;
          console.log(`[FloatingCopilot] UseScreen prefetch: OCR'd BitBlt image into ${imageText.length} chars for text-only model`);
        } else {
          // Nothing legible in the frame. Drop the image rather than dispatching
          // one that will be stripped, so the "could not capture" branch below
          // reports the truth instead of the model doing it for us.
          prefetchedImage = null;
          console.warn('[FloatingCopilot] UseScreen prefetch: image OCR yielded no usable text on a text-only model');
        }
        prefetchSw.mark('image-ocr');
      }
      }

      prefetchSw.report(
        prefetchedText ? `text ${prefetchedText.length} chars` : prefetchedImage ? 'image' : 'empty',
      );

      // If still nothing, inform the user instead of sending empty context
      if (!prefetchedText && !prefetchedImage) {
        console.warn('[FloatingCopilot] UseScreen: No screen content captured on first click');
        // Don't call AI with empty context — that's what causes "ready to help"
        // Set a minimal fallback message in chat
        setChatHistory(prev => [...prev, {
          id: generateId(),
          role: 'assistant',
          text: 'Could not read the screen. Make sure the target window is visible and in front, then try again.',
        }]);
        useScreenPendingRef.current = false;
        return;
      }

      // --- We have fresh context. Now update refs and dispatch to AI. ---

      // Store prefetched text into screenTextRef so triggerAI picks it up
      if (prefetchedText) {
        screenTextRef.current = prefetchedText;
      }

      // Store prefetched image into phoneImageRef (reuse the same path
      // triggerAI already supports for phone camera images)
      if (prefetchedImage && !prefetchedText) {
        phoneImageRef.current = prefetchedImage;
      }

      const query = inputText.trim();
      const echoed = query || 'Answer the question on my screen';
      setChatHistory(prev => [...prev, { id: generateId(), role: 'user', text: echoed }]);
      if (query) setInputText('');

      // Auto-expand overlay so the answer is visible
      if (isNativeOverlay && (overlayModeRef.current === 'compact' || overlayModeRef.current === 'expanded')) {
        setOverlayMode('maximized');
      }

      // Dispatch to AI — don't await the full streaming response here.
      // Release the pending lock immediately so buttons stay responsive
      // while the AI streams its answer in the background.
      // Wrap in catch to prevent unhandled rejections from freezing the renderer.
      triggerAIRef.current(query || undefined).catch((err) => {
        if (err?.name !== 'AbortError') {
          console.error('[FloatingCopilot] UseScreen triggerAI failed:', err);
        }
      });
    } catch (err) {
      console.error('[FloatingCopilot] Use Screen failed:', err);
      toast.error(
        err instanceof Error
          ? `Screen capture failed: ${err.message}`
          : 'Screen capture failed',
      );
    } finally {
      useScreenPendingRef.current = false;
    }
  }, [screen, inputText, isNativeOverlay, setOverlayMode, raceTimeout]);

  // Phone Camera Input toggle handler
  // Click once -> Starts server & opens QR overlay (turns button active).
  // Click again when active -> Disables server & closes overlay (turns button inactive).
  const handleTogglePhoneModal = useCallback(async () => {
    if (phoneServerActive) {
      // Toggle OFF / Disable
      if (electronAPI?.stopPhoneServer) {
        try {
          await electronAPI.stopPhoneServer();
        } catch (err) {
          console.warn('[FloatingCopilot] Failed to stop phone server:', err);
        }
      }
      setPhoneServerActive(false);
      setPhoneModalOpen(false);
      phoneImageRef.current = null;
      return;
    }

    // Toggle ON / Enable
    if (isCompact && setOverlayMode) {
      setOverlayMode('expanded');
    }

    if (electronAPI?.startPhoneServer) {
      try {
        const info = await electronAPI.startPhoneServer();
        setPhoneServerUrl(info.qrUrl);
        setPhoneServerActive(true);
        setPhoneModalOpen(true);
      } catch (err) {
        console.error('[FloatingCopilot] Failed to start phone server:', err);
        toast.error('Failed to start phone camera server');
      }
    }
  }, [phoneServerActive, electronAPI, isCompact, setOverlayMode]);

  // Stop the in-flight AI response mid-stream so the user can immediately ask
  // something else. Reuses the same abort + generation-counter machinery as the
  // manual-override path in triggerAI (Req 12.1, 12.2): the transport is
  // aborted, `requestIdRef` is bumped so any token that still arrives is
  // discarded, and whatever streamed so far is committed to the chat history
  // rather than thrown away.
  const handleStopGeneration = useCallback(() => {
    if (!isLoading && !isStreaming) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    requestIdRef.current += 1;

    const partial = streamingText.trim();
    if (partial) {
      setChatHistory(prev => [
        ...prev,
        { id: generateId(), role: 'assistant', text: partial },
      ]);
    }

    setStreamingText('');
    setReasoningText('');
    setIsStreaming(false);
    isStreamingRef.current = false;
    setIsLoading(false);
    // Hand focus straight back to the input so the next question can be typed
    // without an extra click.
    inputRef.current?.focus();
  }, [isLoading, isStreaming, streamingText]);

  const handleModeChange = useCallback((mode: CopilotMode) => {
    setActiveMode(mode);
    setAiResponse(null);
    setChatHistory([]);
  }, []);

  const handleStop = useCallback(async () => {
    // Prevent double-click while summary is in flight (Requirement 27.4)
    if (isGeneratingSummary) return;

    const flushedLine = speech.stop();
    systemAudio.disable();
    screen.stopCapture();
    questionDetectorRef.current.reset();

    // Build transcript from the merged mic + system-audio lines, plus the
    // flushed interim line from stop() to avoid data loss. Re-sort so the
    // flushed line lands in timestamp order.
    const rawLines = [...mergedTranscript];
    if (flushedLine) {
      rawLines.push(flushedLine);
      rawLines.sort((a, b) => a.timestamp - b.timestamp);
    }
    const transcriptLines = rawLines.map(l => ({
      id: l.id,
      text: l.text,
      timestamp: l.timestamp,
      speaker: l.speakerId,
      isInterim: l.isInterim,
      speakerRole: l.speakerRole,
      asrConfidence: l.asrConfidence,
      language: l.language,
      detection: l.detection,
      provider: l.provider,
    }));

    // Step 1: Persist placeholder meeting FIRST (Requirement 27.1)
    // This ensures the transcript is never lost even if the tab closes mid-generation.
    const meetingId = `meeting-${generateId()}`;
    const placeholderMeeting = await persistPlaceholderMeeting({
      id: meetingId,
      userId: user?.uid,
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

    // Navigate IMMEDIATELY with the placeholder meeting so the UI feels instant.
    // Summary generation runs in the background and updates the meeting record
    // in IndexedDB — the detail page can poll or show a "generating..." state.
    stopCopilot(placeholderMeeting);

    // Fire-and-forget: generate summary in the background (Requirements 27.2, 27.3)
    const summaryAbortController = new AbortController();
    generateSummaryWithTimeout(
      placeholderMeeting,
      apiKey,
      summaryAbortController.signal,
    ).catch((err) => {
      console.warn('[FloatingCopilot] Background summary generation failed:', err);
    });
  }, [speech, systemAudio, mergedTranscript, screen, activeMode, elapsedTime, aiSuggestionCount, coaching, apiKey, stopCopilot, isGeneratingSummary]);

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
          </div>
        </div>
      )}

      {/* Upgrade Modal overlay */}
      {upgradeModal && (
        <UpgradeModal
          reason={upgradeModal.reason}
          feature={upgradeModal.feature}
          onClose={() => setUpgradeModal(null)}
        />
      )}

      {/* ===== FLOATING OVERLAY (Cluely-style) ===== */}
      {/* In native overlay mode, the BrowserWindow itself handles position
          via `-webkit-app-region: drag`. The internal useDraggable positioning
          is disabled (left/top forced to 0) so the capsule fills the window
          and dragging the capsule moves the native window (Req 10.4). */}
      <div
        ref={dragRef}
        className={`copilot-overlay ${isNativeOverlay ? `native-overlay-mode mode-2-card-root overlay-${overlayMode}` : ''}`}
        data-zule-stealth="true"
        role="region"
        aria-label="Zule AI copilot"
        style={
          isNativeOverlay
            ? { left: 0, top: 0, position: 'relative' }
            : { left: position.x, top: position.y }
        }
      >
        {/* Update indicator — absolutely positioned, no layout impact (Req 7.1, 7.3) */}
        {isNativeOverlay && <UpdateIndicator status={updateState.status} />}

        <ControlCapsule
          isHidden={isHidden}
          onToggleHidden={() => setIsHidden(!isHidden)}
          onStop={handleStop}
          handleRef={(node) => { handleRef.current = node as HTMLDivElement; }}
          overlayMode={overlayMode}
          onToggleMode={toggleMode}
          isStealth={isStealth}
          onToggleStealth={isElectronEnv ? handleToggleStealth : undefined}
          isSystemAudioActive={systemAudio.isActive}
          onToggleSystemAudio={
            systemAudio.isSupported
              ? () => { void (systemAudio.isActive ? systemAudio.disable() : systemAudio.enable()); }
              : undefined
          }
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
            {/* Manual "Assist now" — forces an AI answer from the recent
                transcript even when no question was auto-detected (auto-detect
                can miss when transcription is imperfect). */}
            <button
              type="button"
              className="card-assist-now-btn"
              onClick={() => triggerAI()}
              disabled={isLoading || isStreaming}
              aria-label="Get an AI answer now from the recent conversation"
            >
              <Sparkles size={13} />
              <span>Assist now</span>
            </button>
            {isNativeOverlay && !isCompact && (
              <button
                type="button"
                className={`card-maximize-btn ${isMaximized ? 'is-maximized' : ''}`}
                onClick={toggleMaximize}
                aria-label={isMaximized ? 'Restore overlay size' : 'Maximize overlay'}
                aria-pressed={isMaximized}
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
            {/* Detected question notification banner */}
            {detectedQuestion && (
              <div className="detected-question-banner" aria-live="assertive">
                <span className="detected-question-icon">🎯</span>
                <span className="detected-question-label">Detected question:</span>
                <span className="detected-question-text">"{detectedQuestion}"</span>
              </div>
            )}
            {/* Live captions — confirm transcription is working at a glance.
                A short rolling window of recent lines (newest last), labelled by
                speaker, with any in-progress speech shown as a live pulsing line.
                Only rendered when system audio or mic is active. */}
            {(systemAudio.isActive || speech.isListening) && liveCaptions.length > 0 && (
              <div className="live-caption-stack" aria-live="polite" aria-label="Live transcript">
                {liveCaptions.map((c) => (
                  <div
                    key={c.key}
                    className={`live-caption live-caption-${c.role} ${c.live ? 'is-live' : ''}`}
                  >
                    <span className="live-caption-speaker">
                      {c.role === 'user' ? 'You' : 'Them'}
                    </span>
                    <span className="live-caption-text">{c.text}</span>
                  </div>
                ))}
              </div>
            )}
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
                  <button
                    className="copy-response-btn"
                    onClick={() => {
                      void copyTextToClipboard(msg.text).then((ok) => {
                        // Report what actually happened. A toast that says
                        // "Copied" over an empty clipboard is worse than no
                        // toast: the User pastes into their editor and finds
                        // nothing, with no reason to suspect the copy.
                        if (ok) {
                          toast.success('Copied to clipboard', { duration: 1500 });
                        } else {
                          toast.error('Could not copy — select the text and press Ctrl+C', {
                            duration: 2500,
                          });
                        }
                      });
                    }}
                    aria-label="Copy response"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              )
            ))}
            {/* Show current streaming / loading state for the in-flight response */}
            {(isLoading || isStreaming) && (
              <SuggestionCard
                isLoading={isLoading}
                isStreaming={isStreaming}
                streamingText={streamingText}
                reasoningText={reasoningText}
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
            isFeatureAvailable={isFeatureAvailable}
            onLockedModeClick={(feature) => setUpgradeModal({ reason: 'feature-locked', feature })}
          />

          <InputBar
            inputText={inputText}
            onInputChange={setInputText}
            onSubmit={handleSubmit}
            isLoading={isLoading}
            inputRef={inputRef}
            onUseScreen={handleUseScreen}
            isScreenActive={screen.isCapturing && sendScreenKeyframe}
            onPhoneCapture={handleTogglePhoneModal}
            isPhoneActive={phoneServerActive || phoneModalOpen}
            onDictationStart={() => {
              // Pause the main mic so the two SpeechRecognition instances on
              // the same mic don't collide and kill the main pipeline.
              dictationWasListening.current = speech.isListening;
              speech.pause();
            }}
            onDictationEnd={() => {
              if (dictationWasListening.current) speech.resume();
              dictationWasListening.current = false;
            }}
            isGenerating={isLoading || isStreaming}
            onStopGeneration={handleStopGeneration}
          />

          {/* Phone Camera Capture Overlay — scoped cleanly inside suggestion-card */}
          {phoneModalOpen && (
            <PhoneCapture
              isOpen={phoneModalOpen}
              onClose={() => setPhoneModalOpen(false)}
              serverUrl={phoneServerUrl}
              isServerActive={phoneServerActive}
              onStartServer={async () => {
                if (electronAPI?.startPhoneServer) {
                  try {
                    const info = await electronAPI.startPhoneServer();
                    setPhoneServerUrl(info.qrUrl);
                    setPhoneServerActive(true);
                  } catch (err) {
                    toast.error('Failed to start phone server');
                  }
                }
              }}
              onStopServer={async () => {
                if (electronAPI?.stopPhoneServer) {
                  await electronAPI.stopPhoneServer();
                  setPhoneServerActive(false);
                }
              }}
              lastImageTime={lastPhoneImageTime}
            />
          )}
        </div>
      </div>
    </div>
  );
}
