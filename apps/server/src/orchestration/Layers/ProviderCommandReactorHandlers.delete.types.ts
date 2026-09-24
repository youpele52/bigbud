import type { OrchestrationSession, OrchestrationThread, ThreadId } from "@bigbud/contracts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { Effect } from "effect";

import type { OrchestrationDispatchError } from "../Errors.ts";

export interface DeletionDeps {
  readonly resolveThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  readonly setThreadSession: (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchError>;
}

export type DeleteRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.deletion-requested" }
>;
