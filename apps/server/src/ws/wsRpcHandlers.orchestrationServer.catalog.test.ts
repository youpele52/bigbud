import { CommandId, ORCHESTRATION_WS_METHODS, ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeWsRpcOrchestrationServerHandlers } from "./wsRpcHandlers.orchestrationServer.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

it.effect("routes the global sidebar catalog RPC to the projection query", () =>
  Effect.gen(function* () {
    const context = {
      projectionCatalogQuery: {
        getSidebarThreadCatalog: () =>
          Effect.succeed({
            projectionSequence: 8,
            threads: [],
            recentThreadIds: [],
            pinnedThreadIds: [],
          }),
      },
    } as unknown as WsRpcContext;
    const handlers = makeWsRpcOrchestrationServerHandlers(context);
    const handler = handlers[ORCHESTRATION_WS_METHODS.getSidebarThreadCatalog];

    assert.equal((yield* handler({})).projectionSequence, 8);
  }),
);

it.effect("routes selected-thread detail RPCs to the catalog query service", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.makeUnsafe("thread-rpc");
    let receivedThreadId: string | null = null;
    const context = {
      projectionCatalogQuery: {
        getSelectedThreadDetail: (input: { readonly threadId: ThreadId }) => {
          receivedThreadId = input.threadId;
          return Effect.succeed({
            projectionSequence: 7,
            threadId,
            projectId: ProjectId.makeUnsafe("project-rpc"),
            activityTurnId: null,
            messages: [],
            messageWindow: {
              order: "newest-first" as const,
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
          });
        },
      },
    } as unknown as WsRpcContext;
    const handlers = makeWsRpcOrchestrationServerHandlers(context);
    const handler = handlers[ORCHESTRATION_WS_METHODS.getSelectedThreadDetail];
    const result = yield* handler({ threadId });

    assert.equal(receivedThreadId, threadId);
    assert.equal(result.projectionSequence, 7);
  }),
);

it.effect("routes typed thread ownership RPCs to the orchestration engine", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.makeUnsafe("thread-ownership-rpc");
    const context = {
      orchestrationEngine: {
        resolveThreadOwnership: (receivedThreadId: ThreadId) =>
          Effect.succeed({
            threadId: receivedThreadId,
            projectId: "project-rpc",
            status: "archived" as const,
            serverEpoch: "server-rpc",
            canonicalRevision: 9,
          }),
      },
    } as unknown as WsRpcContext;
    const handlers = makeWsRpcOrchestrationServerHandlers(context);
    const handler = handlers[ORCHESTRATION_WS_METHODS.getThreadOwnership];

    assert.deepStrictEqual(yield* handler({ threadId }), {
      threadId,
      projectId: ProjectId.makeUnsafe("project-rpc"),
      status: "archived",
      serverEpoch: "server-rpc",
      canonicalRevision: 9,
    });
  }),
);

it.effect("routes command outcome RPCs without exposing receipt errors", () =>
  Effect.gen(function* () {
    const commandId = CommandId.makeUnsafe("command-outcome-rpc");
    const context = {
      orchestrationEngine: {
        getCommandOutcome: (receivedCommandId: CommandId) =>
          Effect.succeed({
            commandId: receivedCommandId,
            status: "rejected" as const,
            aggregateKind: "project" as const,
            aggregateId: ProjectId.makeUnsafe("project-rpc"),
            rejectedAt: "2026-08-26T12:00:00.000Z",
            reason: "thread_already_exists" as const,
            resultSequence: 9,
            serverEpoch: "server-rpc",
            canonicalRevision: 9,
          }),
      },
    } as unknown as WsRpcContext;
    const handlers = makeWsRpcOrchestrationServerHandlers(context);

    assert.deepStrictEqual(
      yield* handlers[ORCHESTRATION_WS_METHODS.getCommandOutcome]({ commandId }),
      {
        commandId,
        status: "rejected",
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-rpc"),
        rejectedAt: "2026-08-26T12:00:00.000Z",
        reason: "thread_already_exists",
        resultSequence: 9,
        serverEpoch: "server-rpc",
        canonicalRevision: 9,
      },
    );
  }),
);

it.effect("preserves typed replay range metadata through the RPC handler", () =>
  Effect.gen(function* () {
    const replay = {
      requestedFromSequenceExclusive: 2,
      retainedFromSequenceExclusive: 5,
      earliestAvailableSequence: 6,
      latestSequence: 9,
      availability: "gap" as const,
      complete: false,
      events: [],
    };
    const context = {
      orchestrationEngine: {
        readReplay: () => Effect.succeed(replay),
      },
    } as unknown as WsRpcContext;
    const handlers = makeWsRpcOrchestrationServerHandlers(context);
    const handler = handlers[ORCHESTRATION_WS_METHODS.replayEvents];

    assert.deepStrictEqual(yield* handler({ fromSequenceExclusive: 2 }), replay);
  }),
);
