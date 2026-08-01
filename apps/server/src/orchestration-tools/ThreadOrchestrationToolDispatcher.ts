import type {
  BrowserAction,
  BrowserResult,
  ComputerUseAction,
  ComputerUseResult,
  ThreadId,
  MessageId,
  ProjectId,
} from "@bigbud/contracts";
import type { Effect } from "effect";

import type { ThreadWorkflowStatusSnapshot } from "../orchestration/ThreadWorkflowStatus.logic.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import type {
  listPinnedThreadsViaOrchestration,
  setThreadPinnedViaOrchestration,
  createThreadViaOrchestration,
} from "./ThreadOrchestrationTools.ts";
import type { sendThreadMessageViaOrchestration } from "./ThreadOrchestrationTools.sendMessage.ts";
import type {
  ListThreadsStatusFilter,
  listThreadsViaOrchestration,
} from "./ThreadOrchestrationTools.listThreads.ts";

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
    readonly threadDelegationRepository?: ThreadDelegationRepositoryShape;
  }) => Effect.Effect<ThreadWorkflowStatusSnapshot, Error>;
  readonly listPinned: (input: {
    readonly callerThreadId: ThreadId;
  }) => ReturnType<typeof listPinnedThreadsViaOrchestration>;
  readonly setPinned: (input: {
    readonly callerThreadId: ThreadId;
    readonly threadId: ThreadId;
    readonly pinned: boolean;
  }) => ReturnType<typeof setThreadPinnedViaOrchestration>;
  readonly computerUse: (input: {
    readonly threadId: ThreadId;
    readonly action: ComputerUseAction;
  }) => Effect.Effect<ComputerUseResult, Error>;
  readonly browser: (input: {
    readonly threadId: ThreadId;
    readonly action: BrowserAction;
  }) => Effect.Effect<BrowserResult, Error>;
  readonly createThread?: (input: {
    readonly callerThreadId: ThreadId;
    readonly sourceMessageId: MessageId;
    readonly invocationId: string;
    readonly title: string;
    readonly task: string;
    readonly projectId?: ProjectId;
    readonly watchForCompletion: boolean;
  }) => ReturnType<typeof createThreadViaOrchestration>;
  readonly sendMessage?: (input: {
    readonly callerThreadId: ThreadId;
    readonly threadId: ThreadId;
    readonly message: string;
    readonly delivery: "auto" | "queue";
    readonly invocationId: string;
  }) => ReturnType<typeof sendThreadMessageViaOrchestration>;
  readonly listThreads?: (input: {
    readonly callerThreadId: ThreadId;
    readonly projectId?: ProjectId | undefined;
    readonly status?: ListThreadsStatusFilter | undefined;
    readonly limit?: number | undefined;
    readonly includeExcerpt?: boolean | undefined;
  }) => ReturnType<typeof listThreadsViaOrchestration>;
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
