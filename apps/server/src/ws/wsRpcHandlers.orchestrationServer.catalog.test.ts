import { ORCHESTRATION_WS_METHODS, ThreadId } from "@bigbud/contracts";
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
            projectId: "project-rpc",
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
