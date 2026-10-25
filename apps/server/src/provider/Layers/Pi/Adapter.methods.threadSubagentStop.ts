/**
 * Thread Stop for Pi background subagents. `abort` ends foreground subagents, but pi-subagents
 * documents that detached async runs keep going, so each running run is stopped with the
 * extension's `/subagents-stop <run-id>` command, which Pi runs immediately even while streaming.
 * Async rows only come from that extension's widget, so the command is never sent without it.
 *
 * @module PiAdapter.methods.threadSubagentStop
 */
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";

import { ProviderAdapterRequestError, type ProviderAdapterError } from "../../Errors.ts";
import type { ProviderThreadSubagentRef } from "../../Services/ProviderAdapter.ts";
import type { PiAdapterShape } from "../../Services/Pi/Adapter.ts";
import type { ActivePiSession } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { toMessage } from "./Adapter.utils.ts";

/**
 * Distinct async run IDs from background rows. An async row's native ID is the URI-encoded run
 * node ID followed by `:`-joined child node IDs, so the run ID is the decoded first segment.
 */
export function piAsyncRunIds(subagents: ReadonlyArray<ProviderThreadSubagentRef>): string[] {
  const runIds = new Set<string>();
  for (const subagent of subagents) {
    if (!subagent.background) continue;
    const [encoded] = subagent.nativeId.split(":");
    let runId: string;
    try {
      runId = decodeURIComponent(encoded ?? "");
    } catch {
      continue;
    }
    // One command argument: never pass whitespace that would split into a child selector.
    if (/^\S+$/.test(runId)) runIds.add(runId);
  }
  return [...runIds];
}

export function makePiStopThreadSubagents(deps: {
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ActivePiSession, ProviderAdapterError>;
}): NonNullable<PiAdapterShape["stopThreadSubagents"]> {
  return Effect.fn("stopThreadSubagents")(function* (threadId, subagents) {
    const runIds = piAsyncRunIds(subagents);
    if (runIds.length === 0) return;
    const session = yield* deps.requireSession(threadId);
    for (const runId of runIds) {
      yield* Effect.tryPromise({
        try: () => session.process.request({ type: "prompt", message: `/subagents-stop ${runId}` }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: toMessage(cause, `Failed to stop Pi background run ${runId}.`),
            cause,
          }),
      }).pipe(
        // Keep stopping the remaining runs; the row cleanup settles what is left.
        Effect.catch((error) =>
          Effect.logWarning("pi background run stop failed", { runId, detail: error.detail }),
        ),
      );
    }
  });
}
