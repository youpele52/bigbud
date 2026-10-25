/**
 * Per-subagent Stop for Claude (D3). Only a running provider subagent of the live session can
 * be stopped; Stop-all (`interruptTurn`) is separate and unchanged. The SDK reports the outcome
 * as a `task_notification` with status `stopped`, so no state is changed here.
 *
 * @module ClaudeAdapter.controls.subagents
 */
import { type ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { ProviderAdapterValidationError, type ProviderAdapterError } from "../../Errors.ts";
import type { ClaudeAdapterShape } from "../../Services/Claude/Adapter.ts";
import { isClaudeProviderSubagent } from "./Adapter.tasks.classify.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import { PROVIDER } from "./Adapter.types.ts";
import { toRequestError } from "./Adapter.utils.ts";

const OPERATION = "subagent/stop";

export function makeClaudeStopSubagent(input: {
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ClaudeSessionContext, ProviderAdapterError>;
}): NonNullable<ClaudeAdapterShape["stopSubagent"]> {
  return Effect.fn("stopSubagent")(function* (threadId: ThreadId, nativeTaskId: string) {
    const context = yield* input.requireSession(threadId);
    const task = context.taskState.tasks.get(nativeTaskId);
    const running = task?.status === "pending" || task?.status === "inProgress";
    if (!task || !running || !isClaudeProviderSubagent(task, context.providerSubagentsSupported)) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: OPERATION,
        issue: "That subagent is not running in this session.",
      });
    }
    yield* Effect.tryPromise({
      try: () => context.query.stopTask(nativeTaskId),
      catch: (cause) => toRequestError(threadId, OPERATION, cause),
    });
    yield* Effect.logInfo("claude subagent stop requested", { threadId, nativeTaskId });
  });
}
