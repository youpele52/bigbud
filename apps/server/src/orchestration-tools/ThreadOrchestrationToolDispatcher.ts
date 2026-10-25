import type {
  BrowserAction,
  BrowserResult,
  ComputerUseAction,
  ComputerUseResult,
  ThreadId,
  MessageId,
  ProjectId,
  ServerProvider,
} from "@bigbud/contracts";
import type { ServerSettings } from "@bigbud/contracts/core/settings.ts";
import type { Effect } from "effect";

import type { ThreadWorkflowStatusSnapshot } from "../orchestration/ThreadWorkflowStatus.logic.ts";
import type { ThreadDelegationRepositoryShape } from "../persistence/Services/ThreadDelegations.ts";
import type {
  listPinnedThreadsViaOrchestration,
  setThreadPinnedViaOrchestration,
} from "./ThreadOrchestrationTools.ts";
import type { createThreadViaOrchestration } from "./ThreadOrchestrationTools.createThread.ts";
import type { listAvailableModelsViaOrchestration } from "./ThreadOrchestrationTools.listAvailableModels.ts";
import type { RecentModelSelection } from "./ThreadOrchestrationTools.modelChoice.usable.ts";
import type { sendThreadMessageViaOrchestration } from "./ThreadOrchestrationTools.sendMessage.ts";
import type {
  ListThreadsStatusFilter,
  listThreadsViaOrchestration,
} from "./ThreadOrchestrationTools.listThreads.ts";
import type { AgentWorkspaceToolInput } from "./AgentWorkspaceTools.ts";

export interface ThreadOrchestrationToolDispatcherShape {
  readonly getSystemResources?: () => Effect.Effect<Record<string, unknown>, Error>;
  readonly workspace?: (
    input: AgentWorkspaceToolInput,
  ) => Effect.Effect<Record<string, unknown>, Error>;
  readonly rename: (input: {
    readonly threadId: ThreadId;
    readonly targetThreadId?: ThreadId;
    readonly title: string;
    readonly invocationId?: string;
    readonly sourceMessageId?: MessageId;
  }) => Effect.Effect<
    { readonly title: string; readonly threadId?: ThreadId; readonly commandId?: string },
    Error
  >;
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
    /** Raw agent request; validated server-side and never a reason to fail (Goal 11). */
    readonly modelSelection?: unknown;
  }) => ReturnType<typeof createThreadViaOrchestration>;
  readonly listAvailableModels?: (input: {
    readonly callerThreadId: ThreadId;
    readonly limit?: number | undefined;
  }) => ReturnType<typeof listAvailableModelsViaOrchestration>;
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

/**
 * Runtime inputs of delegated model choice. The engine layer that installs the dispatcher cannot
 * depend on provider layers, so a server layer installs these beside it (plan D9).
 */
export interface ThreadToolModelSources {
  /** Cached snapshots only; the tool path never refreshes providers. */
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly getSettings: Effect.Effect<ServerSettings, Error>;
  readonly listRecent: (limit: number) => Effect.Effect<ReadonlyArray<RecentModelSelection>, Error>;
  readonly hasInteractiveClient: () => boolean;
}

let dispatcher: ThreadOrchestrationToolDispatcherShape | null = null;
let modelSources: ThreadToolModelSources | null = null;

export function setThreadToolModelSources(next: ThreadToolModelSources | null): void {
  modelSources = next;
}

export function getThreadToolModelSources(): ThreadToolModelSources | null {
  return modelSources;
}

export function setThreadOrchestrationToolDispatcher(
  next: ThreadOrchestrationToolDispatcherShape | null,
): void {
  dispatcher = next;
}

export function getThreadOrchestrationToolDispatcher(): ThreadOrchestrationToolDispatcherShape | null {
  return dispatcher;
}
