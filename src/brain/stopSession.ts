// ============================================
// Zule AI — Stop-Session Flow (Reordered)
// ============================================
//
// Implements the reordered stop-session lifecycle per Requirements 10.1,
// 10.5, 27.1, 27.2, 27.3, 27.4:
//
// 1. Immediately persist a placeholder meeting with aiSummaryStatus = 'pending'
//    so that no transcript is lost if the tab is closed during summary generation.
// 2. Generate summary with a 60 000 ms timeout via AbortController + setTimeout.
// 3. On success: update the meeting with aiSummaryStatus = 'ok', summary data.
// 4. On failure/timeout: update with aiSummaryStatus = 'failed'.
// 5. Save extracted keyFacts via MemoryStore.applyRedactionAndSave.
//
// This module exports:
//   - `persistPlaceholderMeeting`: Step 1 — saves a meeting with pending status.
//   - `generateSummaryWithTimeout`: Step 2-4 — generates summary bounded by timeout.
//   - `retrySummary`: Re-invokes summary generation on an existing persisted meeting.
//   - `StopSessionState`: A state machine type for UI use.

import { generateMeetingSummary, type MeetingSummaryResult } from './summaryEngine';
import type { StoredMeeting } from '../data/database';
import { database } from '../data/database';
import { pendingTaskTracker } from '../utils/pendingTaskTracker';

// --- Types ---

export type StopSessionPhase = 'idle' | 'persisting' | 'generating-summary' | 'done';

export interface StopSessionState {
  phase: StopSessionPhase;
  meetingId: string | null;
}

export const SUMMARY_TIMEOUT_MS = 60_000;

// --- Step 1: Persist placeholder meeting ---

/**
 * Persist a meeting record with `aiSummaryStatus: 'pending'` immediately.
 * This ensures the transcript is durable regardless of what happens during
 * summary generation (Requirement 27.1).
 */
export async function persistPlaceholderMeeting(
  meeting: Omit<StoredMeeting, 'summary' | 'aiSummaryStatus' | 'actionItems' | 'followUpEmail' | 'keyFacts'>,
): Promise<StoredMeeting> {
  const placeholder: StoredMeeting = {
    ...meeting,
    summary: '',
    aiSummaryStatus: 'pending',
    actionItems: [],
    followUpEmail: '',
    keyFacts: [],
  };
  await database.saveMeeting(placeholder);
  return placeholder;
}

// --- Step 2-4: Generate summary with timeout ---

export interface SummaryGenerationResult {
  success: boolean;
  meeting: StoredMeeting;
  summaryResult?: MeetingSummaryResult;
}

/**
 * Generate a meeting summary with a 60 000 ms timeout.
 * On success: updates the meeting in IndexedDB with aiSummaryStatus = 'ok'.
 * On failure/timeout: updates with aiSummaryStatus = 'failed'.
 *
 * Returns the updated meeting record in both cases (Requirement 27.2, 27.3).
 *
 * @param meeting - The persisted placeholder meeting
 * @param apiKey - The API key for the AI provider
 * @param signal - Optional AbortSignal for user cancellation (Requirement 27.4)
 */
export async function generateSummaryWithTimeout(
  meeting: StoredMeeting,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SummaryGenerationResult> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  // Link external signal (user cancel) to our internal controller
  if (signal) {
    if (signal.aborted) {
      return markFailed(meeting);
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const summaryPromise = generateMeetingSummary(meeting.transcript, apiKey);

    // Timeout race (Requirement 27.3)
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), SUMMARY_TIMEOUT_MS);
    });

    const result = await Promise.race([
      summaryPromise.then((r) => ({ kind: 'success' as const, data: r })),
      timeoutPromise.then(() => ({ kind: 'timeout' as const })),
    ]);

    if (timeoutId !== null) clearTimeout(timeoutId);

    // Check if user cancelled while we were waiting
    if (controller.signal.aborted || signal?.aborted) {
      return markFailed(meeting);
    }

    if (result.kind === 'timeout') {
      return markFailed(meeting);
    }

    // Success path (Requirement 27.2)
    const summaryData = result.data;
    const updatedMeeting: StoredMeeting = {
      ...meeting,
      summary: summaryData.summary,
      aiSummaryStatus: 'ok',
      actionItems: summaryData.actionItems,
      followUpEmail: summaryData.followUpEmail,
      keyFacts: summaryData.keyFacts,
    };
    await database.saveMeeting(updatedMeeting);

    // Save keyFacts to MemoryStore with redaction (Requirement 10.5)
    const facts = summaryData.keyFacts ?? [];
    if (facts.length > 0) {
      const factSavePromise = saveKeyFactsToMemory(facts, meeting.id);
      pendingTaskTracker.add(factSavePromise).catch((e) => {
        console.error('[stopSession] Failed to save meeting facts to memory:', e);
      });
    }

    return { success: true, meeting: updatedMeeting, summaryResult: summaryData };
  } catch (error) {
    if (timeoutId !== null) clearTimeout(timeoutId);
    console.error('[stopSession] Summary generation failed:', error);
    return markFailed(meeting);
  }
}

// --- Retry summary from meeting detail (Requirement 27.3) ---

/**
 * Retry summary generation for an existing meeting that has
 * `aiSummaryStatus = 'failed'`. Follows the same timeout and update
 * semantics as the initial attempt.
 */
export async function retrySummary(
  meetingId: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SummaryGenerationResult> {
  const meeting = await database.getMeeting(meetingId);
  if (!meeting) {
    throw new Error(`Meeting ${meetingId} not found`);
  }

  // Mark as pending before retry
  const pendingMeeting: StoredMeeting = {
    ...meeting,
    aiSummaryStatus: 'pending',
  };
  await database.saveMeeting(pendingMeeting);

  return generateSummaryWithTimeout(pendingMeeting, apiKey, signal);
}

// --- Internal helpers ---

async function markFailed(meeting: StoredMeeting): Promise<SummaryGenerationResult> {
  const failedMeeting: StoredMeeting = {
    ...meeting,
    aiSummaryStatus: 'failed',
  };
  await database.saveMeeting(failedMeeting);
  return { success: false, meeting: failedMeeting };
}

/**
 * Save key facts to MemoryStore with redaction applied (Requirement 10.5).
 * Uses `MemoryStore.applyRedactionAndSave` for proper redacted-on-write semantics.
 */
async function saveKeyFactsToMemory(facts: string[], meetingId: string): Promise<void> {
  try {
    const { MemoryStore } = await import('./memoryStore');
    const { vectorStore } = await import('./vectorStore');
    const { apply: redact } = await import('./redaction');
    const { cosineSimilarity } = await import('./vectorMath');
    const { database: db } = await import('../data/database');

    // Load user redaction rules from settings
    const rules = await db.getSetting<import('../types/redaction').RedactionRule[]>('redactionRules', []);

    const memoryStore = new MemoryStore({
      generateEmbedding: (text: string) => vectorStore.generateEmbedding(text),
      cosineSimilarity,
      redact,
    });
    await memoryStore.loadFromPersistence();

    await memoryStore.applyRedactionAndSave(
      facts,
      { meetingId, date: Date.now() },
      rules,
    );
  } catch (error) {
    console.error('[stopSession] Failed to save key facts:', error);
  }
}

// --- Pure state-machine helper (for property testing) ---

/**
 * Models the stop-session state machine transitions.
 * Given an initial state and an outcome, returns the next aiSummaryStatus.
 *
 * This is a pure function usable in property-based tests to verify:
 * - The meeting always persists regardless of outcome.
 * - The aiSummaryStatus transitions correctly.
 */
export type SummaryAttemptOutcome = 'success' | 'timeout' | 'error';

export interface StopSessionMeetingState {
  persisted: boolean;
  aiSummaryStatus: 'pending' | 'ok' | 'failed';
  hasTranscript: boolean;
  hasSummary: boolean;
}

/**
 * Pure state machine: given the current meeting state and an attempt outcome,
 * return the next state. The meeting is ALWAYS persisted, and the transcript
 * is NEVER lost regardless of outcome.
 */
export function applyStopSessionOutcome(
  currentState: StopSessionMeetingState,
  outcome: SummaryAttemptOutcome,
): StopSessionMeetingState {
  // The meeting is always persisted (Requirement 27.1)
  // The transcript is never lost (core invariant)
  switch (outcome) {
    case 'success':
      return {
        persisted: true,
        aiSummaryStatus: 'ok',
        hasTranscript: currentState.hasTranscript,
        hasSummary: true,
      };
    case 'timeout':
    case 'error':
      return {
        persisted: true,
        aiSummaryStatus: 'failed',
        hasTranscript: currentState.hasTranscript,
        hasSummary: currentState.hasSummary,
      };
  }
}

/**
 * Given a sequence of summary attempt outcomes (initial + retries),
 * compute the final meeting state. Useful for property testing that
 * the meeting is always preserved across any number of retries.
 */
export function computeFinalState(
  hasTranscript: boolean,
  outcomes: SummaryAttemptOutcome[],
): StopSessionMeetingState {
  let state: StopSessionMeetingState = {
    persisted: true, // Meeting is persisted before any summary attempt
    aiSummaryStatus: 'pending',
    hasTranscript,
    hasSummary: false,
  };

  for (const outcome of outcomes) {
    state = applyStopSessionOutcome(state, outcome);
  }

  return state;
}
