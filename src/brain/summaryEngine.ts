// ============================================
// Zule AI — Summary Engine v2
// ============================================
//
// Generates structured meeting summaries (summary, action items,
// follow-up email, key facts) from a transcript.
//
// v2 changes (Requirements 10.2, 10.3, 10.4, 10.7):
// - Uses `extractJsonObject` (balanced-brace extractor) instead of brittle
//   prefix/suffix stripping + JSON.parse.
// - On extraction failure, retries once with a stricter "respond ONLY with
//   JSON" system prompt.
// - Action items carry: stable id, text, completed state, optional
//   sourceQuote, optional sourceLineId, and a creation timestamp.
// - Background fact saving uses `pendingTaskTracker.add(promise)` rather
//   than `setTimeout(..., 0)` orphan tasks.

import { generateAIResponse } from './aiProvider';
import { extractJsonObject } from './jsonExtract';
import { pendingTaskTracker } from '../utils/pendingTaskTracker';
import type { TranscriptLine } from './contextManager';

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface ActionItem {
  /** Stable identifier for the action item. */
  id: string;
  /** Description of the action. */
  text: string;
  /** Whether the action item has been completed. */
  completed: boolean;
  /** Quote from the transcript that sourced this item. */
  sourceQuote?: string;
  /** Id of the transcript line that sourced this item. */
  sourceLineId?: string;
  /** Epoch ms when the action item was created. */
  timestamp: number;
}

export interface MeetingSummaryResult {
  summary: string;
  actionItems: ActionItem[];
  followUpEmail: string;
  keyFacts?: string[];
}

// ------------------------------------------------------------------
// Internals
// ------------------------------------------------------------------

/**
 * Build the summary prompt from a pre-formatted transcript text.
 */
function buildSummaryPrompt(transcriptText: string): string {
  return `
You are an expert executive assistant. Please analyze the following meeting transcript and generate a structured JSON response containing a summary, action items, a follow-up email draft, and key facts.

Transcript:
${transcriptText}

Please respond ONLY with a valid JSON object in the exact following format, with no markdown formatting or extra text:
{
  "summary": "A concise 2-3 paragraph summary of the meeting, capturing key decisions and discussions.",
  "actionItems": [
    { "text": "Action item description", "sourceQuote": "exact quote from transcript" }
  ],
  "followUpEmail": "A draft of a follow-up email to send to the participants, recapping the meeting and next steps.",
  "keyFacts": [
    "A list of important facts, personal preferences, project details, or contextual knowledge revealed in the meeting that should be remembered for future sessions."
  ]
}
  `;
}

/**
 * A stricter retry prompt used when the first extraction fails.
 */
function buildStrictRetryPrompt(transcriptText: string): string {
  return `
You MUST respond ONLY with JSON. Do NOT include any explanation, markdown formatting, or text outside the JSON object.

Analyze the following meeting transcript and output ONLY a JSON object:

Transcript:
${transcriptText}

Output ONLY this JSON structure:
{"summary":"...","actionItems":[{"text":"...","sourceQuote":"..."}],"followUpEmail":"...","keyFacts":["..."]}
  `;
}

/**
 * Find the transcript line that best matches a given source quote.
 * Returns the line id if a reasonable match is found.
 */
function findSourceLineId(
  transcript: TranscriptLine[],
  sourceQuote: string | undefined,
): string | undefined {
  if (!sourceQuote || !sourceQuote.trim()) return undefined;

  const normalised = sourceQuote.toLowerCase().trim();

  // Try exact substring match first
  for (const line of transcript) {
    if (line.text.toLowerCase().includes(normalised)) {
      return line.id;
    }
  }

  // Fallback: find the line with the most shared words
  const quoteWords = new Set(normalised.split(/\s+/).filter(w => w.length > 2));
  if (quoteWords.size === 0) return undefined;

  let bestId: string | undefined;
  let bestOverlap = 0;

  for (const line of transcript) {
    const lineWords = new Set(line.text.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    let overlap = 0;
    for (const w of quoteWords) {
      if (lineWords.has(w)) overlap++;
    }
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestId = line.id;
    }
  }

  // Require at least 50% word overlap to consider it a match
  if (bestOverlap >= quoteWords.size * 0.5) {
    return bestId;
  }

  return undefined;
}

/**
 * Parse a raw model response into a MeetingSummaryResult.
 * Uses the balanced-brace JSON extractor (Requirement 10.2).
 */
export function parseSummaryResponse(
  rawText: string,
  transcript: TranscriptLine[],
  now: number = Date.now(),
): MeetingSummaryResult | null {
  const parsed = extractJsonObject(rawText);
  if (!parsed) return null;

  const obj = parsed as Record<string, unknown>;

  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const followUpEmail = typeof obj.followUpEmail === 'string' ? obj.followUpEmail : '';
  const keyFacts = Array.isArray(obj.keyFacts)
    ? (obj.keyFacts as unknown[]).filter((f): f is string => typeof f === 'string')
    : undefined;

  const rawItems = Array.isArray(obj.actionItems) ? obj.actionItems : [];
  const actionItems: ActionItem[] = rawItems.map((item: any, index: number) => {
    const text = typeof item?.text === 'string' ? item.text : String(item?.text ?? '');
    const sourceQuote = typeof item?.sourceQuote === 'string' ? item.sourceQuote : undefined;
    const sourceLineId = findSourceLineId(transcript, sourceQuote);
    return {
      id: `ai-${now}-${index}`,
      text,
      completed: false,
      sourceQuote,
      sourceLineId,
      timestamp: now,
    };
  });

  if (!summary && actionItems.length === 0 && !followUpEmail) {
    return null;
  }

  return {
    summary: summary || 'Summary could not be generated.',
    actionItems,
    followUpEmail: followUpEmail || 'Follow-up email could not be generated.',
    keyFacts,
  };
}

// ------------------------------------------------------------------
// Main export
// ------------------------------------------------------------------

export async function generateMeetingSummary(
  transcript: TranscriptLine[],
  apiKey: string,
): Promise<MeetingSummaryResult> {
  const fullTranscriptText = transcript.map(l => `[${l.speaker}]: ${l.text}`).join('\n');

  if (!fullTranscriptText.trim()) {
    return {
      summary: 'No meeting transcript recorded.',
      actionItems: [],
      followUpEmail: 'No meeting transcript recorded.',
    };
  }

  try {
    // First attempt
    const prompt = buildSummaryPrompt(fullTranscriptText);
    const response = await generateAIResponse(
      { systemPrompt: '', knowledgeContext: '', transcriptContext: '', screenContext: '', userQuery: '', fullPrompt: prompt },
      apiKey,
    );

    let result = parseSummaryResponse(response.text, transcript);

    // Retry once with stricter prompt on extraction failure (Requirement 10.3)
    if (!result) {
      const retryPrompt = buildStrictRetryPrompt(fullTranscriptText);
      const retryResponse = await generateAIResponse(
        { systemPrompt: 'You are a JSON-only assistant. Respond ONLY with valid JSON, nothing else.', knowledgeContext: '', transcriptContext: '', screenContext: '', userQuery: '', fullPrompt: retryPrompt },
        apiKey,
      );
      result = parseSummaryResponse(retryResponse.text, transcript);
    }

    if (!result) {
      return {
        summary: 'Summary could not be parsed from model response.',
        actionItems: [],
        followUpEmail: '',
      };
    }

    // Background task: Save facts to cross-session memory (Requirement 10.7)
    const facts = result.keyFacts ?? [];
    if (facts.length > 0) {
      const factSavePromise = (async () => {
        const { database } = await import('../data/database');
        const { vectorStore } = await import('./vectorStore');

        const text = facts.join('\n');
        const chunksWithVectors = [];
        for (const fact of facts) {
          const vector = await vectorStore.generateEmbedding(fact);
          chunksWithVectors.push({ text: fact, vector });
        }

        await database.addDocument(
          `Meeting Insights: ${new Date().toLocaleDateString()}`,
          text,
          'notes',
          chunksWithVectors,
        );
        console.log('Saved', facts.length, 'cross-session facts to memory.');
      })();

      // Register with PendingTaskTracker so it outlives component unmount
      pendingTaskTracker.add(factSavePromise).catch((e) => {
        console.error('Failed to save meeting facts to memory:', e);
      });
    }

    return result;
  } catch (error) {
    console.error('Error generating meeting summary:', error);
    return {
      summary: 'Error generating summary. Please check your API key and try again.',
      actionItems: [],
      followUpEmail: '',
    };
  }
}
