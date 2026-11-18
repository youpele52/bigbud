import { vi } from "vitest";
import { createBaseServerConfig } from "~/components/chat/view/ChatView.browser/fixtures";
import { emitWelcome, setServerConfigSnapshot } from "~/rpc/serverState";
import { __resetNativeApiForTests } from "~/rpc/nativeApi";
import { __resetWsRpcClientForTests } from "~/rpc/wsRpcClient";
import { recordWsConnectionOpened } from "~/rpc/wsConnectionState";
import {
  BUILT_IN_CHATS_PROJECT_ID,
  MessageId,
  TurnId,
  type GetSelectedThreadDetailResult,
  type GetStartupProjectCatalogResult,
  type OrchestrationEvent,
  type OrchestrationDeliveryBatch,
  type ThreadId,
  type ThreadSummary,
} from "@bigbud/contracts";
import { makeEvent } from "~/stores/main/main.store.test.helpers";

export const NOW = "2026-08-16T12:36:09.000Z";
export const TURN_1 = TurnId.makeUnsafe("turn-compact-1");
export const TURN_2 = TurnId.makeUnsafe("turn-main-2");

export function chatsProjectPage(sequence: number): GetStartupProjectCatalogResult {
  return {
    projectionSequence: sequence,
    projects: [
      {
        id: BUILT_IN_CHATS_PROJECT_ID,
        title: "Chats",
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "local",
        executionTargetId: "local",
        workspaceRoot: null,
        lastUsedAt: NOW,
        updatedAt: NOW,
        deletingAt: null,
        threadCount: 1,
        exceptionalThreadCount: 0,
        hasExceptionalThreads: false,
      },
    ],
    remainingCount: 0,
  };
}

export function threadSummary(threadId: ThreadId, sequence: number): ThreadSummary {
  const title = sequence >= 13 ? "Greet User" : "New chat";
  return {
    id: threadId,
    projectId: BUILT_IN_CHATS_PROJECT_ID,
    title,
    purpose: "standard",
    elevatorSummary: title,
    modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: new Date(Date.parse(NOW) + sequence).toISOString(),
    latestUserMessageAt: NOW,
    pinnedAt: null,
    sessionStatus: "running",
    providerName: "codex",
    activeTurnId: TURN_1,
    latestTurnState: "running",
    isWatching: false,
    isWatched: false,
    isDelegated: false,
    isAwaitingApproval: false,
  };
}

export function threadDetail(threadId: ThreadId, sequence: number): GetSelectedThreadDetailResult {
  return {
    projectionSequence: sequence,
    threadId,
    projectId: BUILT_IN_CHATS_PROJECT_ID,
    activityTurnId: TURN_1,
    messages: [
      {
        id: MessageId.makeUnsafe("compact-user-1"),
        role: "user",
        text: "hi",
        attachments: [],
        attachmentsTruncated: false,
        turnId: TURN_1,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    messageWindow: {
      order: "newest-first",
      requestedCursor: null,
      newestCursor: null,
      oldestCursor: null,
      nextCursor: null,
      hasOlder: false,
    },
    activities: [],
    activitiesTruncated: false,
    pendingApprovals: [],
    pendingApprovalsTruncated: false,
    pendingUserInputs: [],
    pendingUserInputsTruncated: false,
    activePlan: null,
    activeTasks: [],
    activeTasksTruncated: false,
    checkpoints: [],
    checkpointsTruncated: false,
  };
}

export function initialReplayEvents(threadId: ThreadId) {
  return [
    makeEvent(
      "thread.created",
      {
        threadId,
        projectId: BUILT_IN_CHATS_PROJECT_ID,
        title: "New chat",
        modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      { sequence: 11 },
    ),
    makeEvent(
      "thread.message-sent",
      {
        threadId,
        messageId: MessageId.makeUnsafe("compact-user-1"),
        role: "user",
        text: "hi",
        turnId: TURN_1,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
      { sequence: 12 },
    ),
    makeEvent(
      "thread.meta-updated",
      { threadId, title: "Greet User", updatedAt: NOW },
      { sequence: 13 },
    ),
  ];
}
export function deliveryBatch(event: OrchestrationEvent): OrchestrationDeliveryBatch {
  return {
    type: "batch",
    route: "direct-unmanaged",
    consumerId: "compact-test",
    consumerGeneration: 1,
    serverEpoch: "server-1",
    subscriptionGeneration: 1,
    batchId: `batch-${event.sequence}`,
    events: [event],
  };
}

export function nativeSettlement(threadId: ThreadId, turnId: TurnId, sequence: number) {
  return makeEvent(
    "thread.turn-settled",
    {
      threadId,
      turnId,
      sessionEpoch: 0,
      outcome: "completed",
      completedAt: NOW,
    },
    { sequence },
  );
}

/** Install window.nativeApi first, then retire any fallback transport before mounting real coordinators. */
export async function primeCompactConnection() {
  await __resetWsRpcClientForTests();
  __resetNativeApiForTests();
  const config = createBaseServerConfig();
  setServerConfigSnapshot({
    ...config,
    providers: [{ ...config.providers[0]!, initialProbeComplete: true, status: "ready" }],
  });
  emitWelcome({
    cwd: "/repo/main",
    projectName: "Main",
    bootstrapThreadId: "main-thread" as never,
  });
  recordWsConnectionOpened();
}

export function announceCompactWelcome() {
  emitWelcome({
    cwd: "/repo/main",
    projectName: "Main",
    bootstrapThreadId: "main-thread" as never,
  });
}

export function compactCommandOutcome(
  acceptedCommands: Map<string, { threadId: ThreadId; sequence: number }>,
) {
  return vi.fn(async ({ commandId }: { commandId: string }) => {
    const accepted = acceptedCommands.get(commandId);
    return accepted
      ? {
          commandId,
          status: "accepted",
          aggregateKind: "thread",
          aggregateId: accepted.threadId,
          resultSequence: accepted.sequence,
        }
      : { commandId, status: "unknown" };
  });
}
