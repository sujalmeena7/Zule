// ============================================
// Zule AI — Session Policy Helpers
// ============================================
//
// Pure predicates that control session-level behaviors such as
// persistence based on the user's privacy mode setting.
//
// Acceptance criteria covered:
//   - 15.4 — WHERE the User has selected `privacy.mode = ephemeral`,
//     THE Meeting_Store SHALL not persist transcripts or summaries to
//     disk and SHALL retain the session only in memory until the
//     Active_Session ends.

/**
 * The two privacy modes supported by the application.
 * - `'normal'`: meetings are persisted to IndexedDB as usual.
 * - `'ephemeral'`: meetings stay in memory only; nothing written to disk.
 */
export type PrivacyMode = 'ephemeral' | 'normal';

/**
 * Determines whether a meeting should be persisted to disk based on
 * the current privacy mode.
 *
 * When ephemeral mode is enabled, this returns `false`, preventing
 * `database.saveMeeting()` from being called at session end.
 */
export function shouldPersistMeeting(privacyMode: PrivacyMode): boolean {
  return privacyMode !== 'ephemeral';
}
