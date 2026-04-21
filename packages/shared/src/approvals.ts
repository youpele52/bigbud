/**
 * Shared approval constants consumed by all provider adapters on the server.
 *
 * @module approvals
 */

/**
 * Milliseconds before an open permission request is automatically approved
 * when the session is running in full-access (non-interactive) mode.
 *
 * SECURITY CONTRACT — keep this value intentional:
 *   • 5 seconds is long enough for a user watching the UI to click "Deny"
 *     before an irreversible action is taken (e.g. deleting files, running
 *     shell commands).
 *   • Reducing this below ~1 s would make manual cancellation effectively
 *     impossible; do not do so without a corresponding UX change (e.g. a
 *     prominent modal with an explicit opt-out).
 *   • This constant is referenced by every provider adapter. Changing it
 *     here affects Codex, Claude, Copilot, and OpenCode simultaneously.
 */
export const FULL_ACCESS_AUTO_APPROVE_AFTER_MS = 5_000;
