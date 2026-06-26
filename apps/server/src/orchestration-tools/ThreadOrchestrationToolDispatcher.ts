import type { ThreadId } from "@bigbud/contracts";
import type { Effect } from "effect";

import type { ThreadWorkflowStatusSnapshot } from "../orchestration/ThreadWorkflowStatus.logic.ts";

export interface ThreadOrchestrationToolDispatcherShape {
  readonly rename: (input: {
    readonly threadId: ThreadId;
    readonly title: string;
  }) => Effect.Effect<{ readonly title: string }, Error>;
  readonly archive: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<{ readonly archived: true }, Error>;
  readonly getStatus: (input: {
    readonly callerThreadId: ThreadId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<ThreadWorkflowStatusSnapshot, Error>;
}

let dispatcher: ThreadOrchestrationToolDispatcherShape | null = null;

export function setThreadOrchestrationToolDispatcher(
  next: ThreadOrchestrationToolDispatcherShape | null,
): void {
  dispatcher = next;
}

export function getThreadOrchestrationToolDispatcher(): ThreadOrchestrationToolDispatcherShape | null {
  return dispatcher;
}
