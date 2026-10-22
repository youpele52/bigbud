import { Effect } from "effect";

import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import type { ResolveRoutableSession } from "./ProviderService.operations.ts";

const OPERATION = "ProviderService.stopThreadSubagents";

/**
 * Thread Stop's subagent cascade. Routes only to a live session (never recovers or starts one).
 * An adapter-specific `stopThreadSubagents` wins; otherwise adapters with per-subagent Stop stop
 * each one; otherwise the turn interrupt is the only stop the provider offers.
 */
export function makeStopThreadSubagents(input: {
  readonly resolveRoutableSession: ResolveRoutableSession;
}): NonNullable<ProviderServiceShape["stopThreadSubagents"]> {
  return Effect.fn("stopThreadSubagents")(function* ({ threadId, subagents }) {
    if (subagents.length === 0) return;
    const routed = yield* input.resolveRoutableSession({
      threadId,
      operation: OPERATION,
      allowRecovery: false,
    });
    const adapter = routed.adapter;
    if (adapter.stopThreadSubagents) {
      return yield* adapter.stopThreadSubagents(routed.threadId, subagents);
    }
    const stopSubagent = adapter.stopSubagent;
    if (adapter.capabilities.subagents?.stop !== true || !stopSubagent) return;
    for (const subagent of subagents) {
      // A foreground subagent usually ended with the turn already; a rejected stop is expected.
      yield* stopSubagent(routed.threadId, subagent.nativeId).pipe(
        Effect.catchCause(() => Effect.void),
      );
    }
  });
}
