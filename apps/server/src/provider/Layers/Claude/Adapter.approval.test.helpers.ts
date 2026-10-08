import { EventId } from "@bigbud/contracts";
import { Effect, Queue, Ref } from "effect";
import { makeApprovalHandlers } from "./Adapter.approval.ts";
import type {
  ClaudeSessionContext,
  PromptQueueItem,
  UnstampedProviderRuntimeEvent,
} from "./Adapter.types.ts";
import { makeClaudeTaskState } from "./Adapter.tasks.ts";
import { FakeClaudeQuery, THREAD_ID } from "./Adapter.test.helpers.ts";

/** Fully typed request-owner fixture; query transport is not used by callback tests. */
export const makeApprovalTestHarness = Effect.fn("makeApprovalTestHarness")(function* (
  publish?: (event: UnstampedProviderRuntimeEvent) => Effect.Effect<void>,
) {
  const services = yield* Effect.services();
  const context: ClaudeSessionContext = {
    session: {
      threadId: THREAD_ID,
      provider: "claudeAgent",
      sessionEpoch: 0,
      status: "ready",
      runtimeMode: "full-access",
      createdAt: "2026-10-08T00:00:00Z",
      updatedAt: "2026-10-08T00:00:00Z",
    },
    sessionEpoch: 0,
    promptQueue: yield* Queue.unbounded<PromptQueueItem>(),
    query: new FakeClaudeQuery(),
    streamFiber: undefined,
    startedAt: "2026-10-08T00:00:00Z",
    basePermissionMode: "bypassPermissions",
    effectivePermissionMode: "bypassPermissions",
    currentApiModelId: undefined,
    currentEffort: undefined,
    currentFastMode: false,
    currentThinking: undefined,
    currentUltracode: false,
    resumeSessionId: "native-session",
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    resolvedApprovals: new Map(),
    resolvedApprovalSuggestions: new Map(),
    requestLedger: new Map(),
    appliedSessionPermissionRequests: new Set(),
    resolvedUserInputs: new Map(),
    turns: [],
    inFlightTools: new Map(),
    taskState: makeClaudeTaskState(),
    lastPlanFingerprint: undefined,
    turnState: undefined,
    lastKnownContextWindow: undefined,
    lastKnownTokenUsage: undefined,
    lastAssistantUuid: undefined,
    lastInterruptReceipt: undefined,
    queuedUserMessageIds: new Set(),
    lastThreadStartedId: undefined,
    seenNativeMessageIds: new Set(),
    mcpStatuses: [],
    requiredMcpServerNames: new Set(),
    modernTaskExposure: true,
    providerSubagentsSupported: true,
    mcpControlsEnabled: true,
    refreshMcpStatuses: undefined,
    stopped: false,
  };
  const events: UnstampedProviderRuntimeEvent[] = [];
  const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(context);
  let stamp = 0;
  const handlers = makeApprovalHandlers({
    makeEventStamp: () =>
      Effect.sync(() => ({
        eventId: EventId.makeUnsafe(`event-${stamp++}`),
        createdAt: "2026-10-08T00:00:00Z",
      })),
    offerRuntimeEvent: (_context, event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(Effect.andThen(publish?.(event) ?? Effect.void)),
    runFork: Effect.runForkWith(services),
    runPromise: Effect.runPromiseWith(services),
    emitProposedPlanCompleted: () => Effect.void,
    contextRef,
    pendingApprovals: context.pendingApprovals,
    pendingUserInputs: context.pendingUserInputs,
    resolvedApprovals: context.resolvedApprovals,
    resolvedApprovalSuggestions: context.resolvedApprovalSuggestions,
    requestLedger: context.requestLedger,
    runtimeMode: "full-access",
  });
  return { ...handlers, context, events };
});
