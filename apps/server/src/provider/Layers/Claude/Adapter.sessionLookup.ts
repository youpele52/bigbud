/**
 * Claude session admission: a stopped context, or one whose stream already ended (`closed`), is
 * never adopted. The router then recovers a new session instead of routing a turn into it.
 *
 * @module Adapter.sessionLookup
 */
import type { ClaudeSessionContext } from "./Adapter.types.ts";

export function isLiveClaudeSession(
  context: Pick<ClaudeSessionContext, "stopped"> & {
    readonly session: Pick<ClaudeSessionContext["session"], "status">;
  },
): boolean {
  return !context.stopped && context.session.status !== "closed";
}
