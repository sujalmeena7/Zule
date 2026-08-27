// ============================================
// Zule AI — Gateway model discovery + speed measurement
// ============================================
//
// Two probes that let the User choose a model by *evidence* instead of by a
// recommendation baked into the app.
//
// The reason this module exists rather than a `RECOMMENDED_FAST_MODELS` array:
// the set of models a gateway fronts, and which of them are free, changes on a
// weekly cadence. OpenRouter listed 14 zero-cost ids in early August 2026, down
// from 15 the week before and 20 before that. Any list shipped in the binary is
// wrong by the next release, and wrong in the worst way — it names a model that
// 404s. So the app asks the gateway what it has (`listGatewayModels`) and then
// times the candidate the User picked (`measureModelSpeed`).
//
// Both probes follow the rules established by `connectionTest.ts`:
//
//   1. **One request, no retries.** A measurement must report what actually
//      happened on the first attempt; retrying would average away the very
//      thing being measured.
//   2. **No User data.** The speed probe's prompt is a fixed literal, so
//      neither probe carries transcript, screen, or Knowledge_Base content and
//      neither needs the redaction attestation or the egress gates.
//   3. **No credential on any surface.** The key travels only in the
//      `Authorization` header, and every returned `detail` string goes through
//      `scrubSecret`, so a gateway that echoes the header back inside a 4xx
//      body cannot surface it in Settings.

import { scrubSecret } from './custom';
import { normalizeBaseUrl } from './endpointValidator';
import { DEFAULT_NON_STREAMING_TIMEOUT_MS, fetchWithTimeout } from './http';

/**
 * Upper bound on the ids returned from `/models`.
 *
 * A large gateway lists several hundred. They land in a `<datalist>`, which the
 * browser filters as the User types, so a long list is genuinely usable — but
 * the cap keeps a misbehaving endpoint from handing the renderer an unbounded
 * array to render.
 */
export const MAX_CATALOG_MODELS = 500;

/**
 * The speed probe's prompt. A fixed literal — no User content of any kind.
 *
 * Asks for roughly forty short tokens because both halves of the measurement
 * need a run of them: time-to-first-word is meaningless without a second word
 * to compare it against, and words-per-second measured over three words is
 * noise. Counting is chosen over anything open-ended so the length is roughly
 * the same on every model, which is what makes two measurements comparable.
 */
const SPEED_PROBE_PROMPT = 'Count from 1 to 40, separated by single spaces. Output nothing else.';

/** `max_tokens` for the speed probe — enough for the count, and no further. */
const SPEED_PROBE_MAX_TOKENS = 128;

/**
 * Wall-clock ceiling on the speed probe, measured from request start to the
 * final chunk.
 *
 * Deliberately generous. The probe's job is to tell the User *which* of their
 * models is slow, and a thinking model can spend half a minute deliberating
 * before it emits an answer token — cutting it off at the 12 000 ms streaming
 * budget would report "timeout" for the exact case the User most needs
 * described. Thirty seconds is long enough to let a deliberating model finish
 * and short enough to stay a bounded wait inside a Settings panel.
 */
export const SPEED_PROBE_TIMEOUT_MS = 30_000;

/** Short, credential-free explanation for each Base_URL rejection reason. */
const BASE_URL_DETAIL: Record<'empty' | 'too-long' | 'unparseable' | 'unsupported-scheme', string> = {
  empty: 'Base URL is required',
  'too-long': 'Base URL is too long',
  unparseable: 'Base URL is not a valid absolute URL',
  'unsupported-scheme': 'Base URL must use http or https',
};

export type CatalogResult =
  | { ok: true; models: string[] }
  | { ok: false; detail: string };

export interface CatalogInput {
  baseUrl: string;
  apiKey?: string;
  /** Injectable `fetch` for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** True for a per-request timeout or a caller/underlying abort. */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return Boolean(err) && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Blank means "no credential": omit the header rather than sending `Bearer `.
  if (apiKey.trim().length > 0) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/**
 * Pull model ids out of a `/models` response body.
 *
 * Handles the OpenAI shape (`{ data: [{ id }] }`) that every OpenAI-compatible
 * gateway implements, and the bare `{ models: [...] }` / top-level-array shapes
 * some self-hosted runtimes return instead. Entries that are neither a string
 * nor an object with a string `id` are skipped rather than rejected outright —
 * one malformed row should not lose the User the other four hundred.
 */
export function extractModelIds(body: unknown): string[] {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : body !== null && typeof body === 'object'
      ? (() => {
          const record = body as { data?: unknown; models?: unknown };
          if (Array.isArray(record.data)) return record.data;
          if (Array.isArray(record.models)) return record.models;
          return [];
        })()
      : [];

  const seen = new Set<string>();
  for (const row of rows) {
    let id: unknown;
    if (typeof row === 'string') {
      id = row;
    } else if (row !== null && typeof row === 'object') {
      const candidate = row as { id?: unknown; name?: unknown };
      id = typeof candidate.id === 'string' ? candidate.id : candidate.name;
    }
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (trimmed.length === 0) continue;
    seen.add(trimmed);
    if (seen.size >= MAX_CATALOG_MODELS) break;
  }

  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * `GET {normalised baseUrl}/models` — the standard OpenAI-compatible listing
 * endpoint.
 *
 * Never throws. A gateway that does not implement `/models` returns
 * `{ ok: false }` and the caller leaves both model fields as free text, which
 * is the pre-existing behaviour: discovery is a convenience, never a gate.
 */
export async function listGatewayModels(input: CatalogInput): Promise<CatalogResult> {
  const apiKey = input.apiKey ?? '';
  const scrub = (text: string): string => scrubSecret(text, apiKey);

  const base = normalizeBaseUrl(input.baseUrl ?? '');
  if (!base.ok) return { ok: false, detail: scrub(BASE_URL_DETAIL[base.reason]) };

  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : DEFAULT_NON_STREAMING_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${base.url}/models`,
      { method: 'GET', headers: authHeaders(apiKey) },
      { timeoutMs, kind: 'non-streaming', fetchImpl: input.fetchImpl },
    );
  } catch (err) {
    if (isAbortError(err)) return { ok: false, detail: scrub(`Timed out after ${timeoutMs} ms`) };
    // The underlying message can contain the URL, so it is never surfaced.
    return { ok: false, detail: scrub('Network request failed') };
  }

  if (!response.ok) {
    // `HTTP <status>` only — never the response body.
    return { ok: false, detail: scrub(`HTTP ${response.status}`) };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, detail: scrub('Response body was not valid JSON') };
  }

  const models = extractModelIds(parsed);
  if (models.length === 0) {
    return { ok: false, detail: scrub('The endpoint listed no models') };
  }
  return { ok: true, models };
}

// --- Speed measurement ---------------------------------------------------

export interface SpeedSample {
  /** ms from request start to the first *answer* character. */
  firstWordMs: number;
  /** ms from request start to the last chunk. */
  totalMs: number;
  /** Words in the answer. Zero-length answers are reported as a failure. */
  words: number;
  /** `words / (totalMs - firstWordMs)`, or `words / totalMs` for a single chunk. */
  wordsPerSec: number;
  /**
   * True when the model streamed chain-of-thought before answering, i.e. the
   * response carried `delta.reasoning` / `delta.reasoning_content`.
   *
   * This is the single most useful bit the probe returns: it distinguishes "this
   * endpoint is far away" from "this model deliberates", and only the second is
   * fixed by choosing a different model.
   */
  thinking: boolean;
  /** ms spent emitting chain-of-thought before the first answer character. */
  thinkingMs: number;
}

export type SpeedResult =
  | ({ ok: true } & SpeedSample)
  | { ok: false; detail: string };

export interface SpeedInput extends CatalogInput {
  modelId: string;
}

/** Format a `SpeedSample` for display: `first word 0.9s · 145 words/sec`. */
export function formatSpeedSample(sample: SpeedSample): string {
  const parts = [
    `first word ${(sample.firstWordMs / 1000).toFixed(1)}s`,
    `${Math.round(sample.wordsPerSec)} words/sec`,
  ];
  if (sample.thinking) {
    parts.push(`thought for ${(sample.thinkingMs / 1000).toFixed(1)}s first`);
  }
  return parts.join(' · ');
}

/**
 * Read one `data:` payload out of an SSE frame, or `null` for a comment,
 * a blank separator, or the `[DONE]` sentinel.
 */
function parseSseData(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (payload.length === 0 || payload === '[DONE]') return null;
  return payload;
}

/**
 * Stream one fixed prompt through `{baseUrl}/chat/completions` and time it.
 *
 * Written against `fetch` directly rather than through
 * `CustomOpenAICompatibleAdapter` for three reasons, all of which would
 * otherwise corrupt the number: the adapter retries with jitter (averaging away
 * the failure being measured), it emits a Spend_Tracker `tokens` event (a
 * diagnostic probe is not User spend), and its `preflight` demands a redaction
 * attestation that a fixed literal carrying no User data has no way to produce.
 *
 * Never throws — every failure is `{ ok: false, detail }` with a scrubbed,
 * credential-free `detail`.
 */
export async function measureModelSpeed(input: SpeedInput): Promise<SpeedResult> {
  const apiKey = input.apiKey ?? '';
  const scrub = (text: string): string => scrubSecret(text, apiKey);

  const base = normalizeBaseUrl(input.baseUrl ?? '');
  if (!base.ok) return { ok: false, detail: scrub(BASE_URL_DETAIL[base.reason]) };

  const modelId = (input.modelId ?? '').trim();
  if (modelId.length === 0) return { ok: false, detail: scrub('Model ID is required') };

  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs
      : SPEED_PROBE_TIMEOUT_MS;

  const body = JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content: SPEED_PROBE_PROMPT }],
    max_tokens: SPEED_PROBE_MAX_TOKENS,
    stream: true,
  });

  // `fetchWithTimeout`'s watchdog covers only the wait for response headers —
  // it clears the timer once they arrive. The body is where a slow model spends
  // its time, so the same deadline is re-armed here over the read loop.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${base.url}/chat/completions`,
        { method: 'POST', headers: authHeaders(apiKey), body },
        { timeoutMs, kind: 'streaming', fetchImpl: input.fetchImpl, signal: controller.signal },
      );
    } catch (err) {
      if (isAbortError(err)) return { ok: false, detail: scrub(`No response within ${Math.round(timeoutMs / 1000)}s`) };
      return { ok: false, detail: scrub('Network request failed') };
    }

    if (!response.ok) return { ok: false, detail: scrub(`HTTP ${response.status}`) };
    if (!response.body) return { ok: false, detail: scrub('The endpoint did not stream a response') };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let firstWordMs = 0;
    let thinkingMs = 0;
    let thinking = false;
    let lastChunkMs = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are newline-delimited; the trailing partial line stays buffered.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const payload = parseSseData(line.trim());
          if (payload === null) continue;

          let frame: unknown;
          try {
            frame = JSON.parse(payload);
          } catch {
            continue; // A malformed frame is not worth failing the measurement.
          }

          const delta = (frame as { choices?: Array<{ delta?: Record<string, unknown> }> })
            .choices?.[0]?.delta;
          if (!delta) continue;

          // Chain-of-thought arrives on its own field and is explicitly *not*
          // the answer — counting it as the first word would report a thinking
          // model as fast, which is the opposite of the truth.
          const reasoning = delta.reasoning ?? delta.reasoning_content;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            thinking = true;
            thinkingMs = performance.now() - startedAt;
          }

          const content = delta.content;
          if (typeof content === 'string' && content.length > 0) {
            if (answer.length === 0) firstWordMs = performance.now() - startedAt;
            answer += content;
            lastChunkMs = performance.now() - startedAt;
          }
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, detail: scrub(`No answer within ${Math.round(timeoutMs / 1000)}s`) };
      }
      return { ok: false, detail: scrub('The response stream ended early') };
    } finally {
      reader.releaseLock?.();
    }

    const words = answer.trim().split(/\s+/).filter(Boolean).length;
    if (words === 0) {
      // A 200 that produced only chain-of-thought, or nothing at all. Reported
      // as a failure because there is no answer to have timed.
      return {
        ok: false,
        detail: scrub(thinking ? 'The model produced only reasoning, no answer' : 'The model returned an empty answer'),
      };
    }

    const totalMs = Math.max(lastChunkMs, firstWordMs);
    // Rate over the *decode* window. Including the wait for the first word would
    // blame the model's throughput for what is latency, and on a thinking model
    // that single number would hide both facts at once.
    const decodeMs = Math.max(1, totalMs - firstWordMs);
    const wordsPerSec = words > 1 ? (words / decodeMs) * 1000 : (words / Math.max(1, totalMs)) * 1000;

    return {
      ok: true,
      firstWordMs: Math.round(firstWordMs),
      totalMs: Math.round(totalMs),
      words,
      wordsPerSec,
      thinking,
      thinkingMs: Math.round(thinkingMs),
    };
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Heuristic: does this model id name a variant that deliberates before
 * answering?
 *
 * Lives in `customProviderConfig` rather than here so Settings can call it
 * during render without statically importing this module — which would pull the
 * adapter, telemetry, and the HTTP layer into the Settings chunk for the sake of
 * one regular expression. Re-exported so a caller that already has this module
 * does not need a second import.
 */
export { looksLikeThinkingModel } from './customProviderConfig';
