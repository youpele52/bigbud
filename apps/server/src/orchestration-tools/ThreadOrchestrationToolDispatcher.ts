import type { ThreadId } from "@bigbud/contracts";
import type { Effect } from "effect";

export interface ThreadOrchestrationToolDispatcherShape {
  readonly rename: (input: {
    readonly threadId: ThreadId;
    readonly title: string;
  }) => Effect.Effect<{ readonly title: string }, Error>;
  readonly archive: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<{ readonly archived: true }, Error>;
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
