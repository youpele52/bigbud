import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts";
import type { MobileRemoteControlScope } from "@bigbud/contracts/server/mobile";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  buildAppUnderTest,
  getWsServerUrl,
  makeDefaultOrchestrationReadModel,
  serverTestLayer,
} from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";
import { withRetriedMobileWsRpcClient } from "./server.test.mobile.ts";

it.layer(serverTestLayer)("mobile command scope", (it) => {
  for (const [scope, type, allowed] of [
    ["read-only", "thread.turn.interrupt", false],
    ["read-only", "thread.approval.respond", false],
    ["approve-only", "thread.turn.interrupt", false],
    ["approve-only", "thread.approval.respond", true],
    ["thread-control", "thread.turn.interrupt", true],
    ["read-only", "thread.archive", false],
    ["approve-only", "thread.archive", false],
    ["thread-control", "thread.archive", true],
    ["read-only", "thread.user-input.respond", false],
    ["approve-only", "thread.user-input.respond", false],
    ["thread-control", "thread.user-input.respond", true],
  ] as const) {
    it.effect(`${scope}: ${type} is ${allowed ? "allowed" : "denied"}`, () =>
      Effect.gen(function* () {
        let dispatched = 0;
        yield* buildAppUnderTest({
          layers: {
            mobileRemoteControl: {
              validateSessionToken: () =>
                Effect.succeed({
                  sessionId: "scope-session",
                  token: "scope-token",
                  scope: scope satisfies MobileRemoteControlScope,
                  createdAt: "2026-11-14T00:00:00.000Z",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                  lastUsedAt: null,
                  revokedAt: null,
                  label: "scope fixture",
                }),
            },
            commandGateway: {
              dispatchNormalized: () =>
                Effect.sync(() => {
                  dispatched += 1;
                  return { sequence: 1 };
                }),
            },
          },
        });
        const wsUrl = yield* getWsServerUrl("/mobile-ws?token=scope-token");
        const result = yield* Effect.scoped(
          withRetriedMobileWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type,
              commandId: `scope-${scope}-${type}`,
              threadId: "thread-default",
              createdAt: "2026-11-14T00:00:00.000Z",
              ...(type === "thread.approval.respond"
                ? { requestId: "approval-1", decision: "accept" }
                : {}),
              ...(type === "thread.user-input.respond"
                ? { requestId: "question-1", answers: { choice: "yes" } }
                : {}),
            } as never),
          ).pipe(Effect.result),
        );
        assert.equal(dispatched, allowed ? 1 : 0);
        assert.equal(result._tag, allowed ? "Success" : "Failure");
        if (!allowed && result._tag === "Failure")
          assert.include(JSON.stringify(result.failure), "scope");
      }).pipe(Effect.provide(serverHttpTestLayer)),
    );
  }
  for (const initialScope of ["read-only", "approve-only", "thread-control"] as const) {
    it.effect(`${initialScope} can read; scope downgrade on the same socket denies mutation`, () =>
      Effect.gen(function* () {
        let scope: MobileRemoteControlScope = initialScope;
        let dispatched = 0;
        yield* buildAppUnderTest({
          layers: {
            mobileRemoteControl: {
              validateSessionToken: () =>
                Effect.sync(() => ({
                  sessionId: "changing-scope",
                  token: "changing-token",
                  scope,
                  createdAt: "2026-11-14T00:00:00.000Z",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                  lastUsedAt: null,
                  revokedAt: null,
                  label: "scope fixture",
                })),
            },
            projectionSnapshotQuery: {
              getMobileRecoveryBaseline: () =>
                Effect.succeed({
                  snapshot: makeDefaultOrchestrationReadModel(),
                  snapshotSequence: 0,
                  selectedThread: null,
                }),
            },
            commandGateway: {
              dispatchNormalized: () =>
                Effect.sync(() => {
                  dispatched++;
                  return { sequence: 1 };
                }),
            },
          },
        });
        const wsUrl = yield* getWsServerUrl("/mobile-ws?token=changing-token");
        yield* Effect.scoped(
          withRetriedMobileWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const snapshot = yield* client[ORCHESTRATION_WS_METHODS.getSnapshot]({});
              assert.isArray(snapshot.threads);
              scope = "read-only";
              const result = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.approval.respond",
                commandId: "changed-scope-approval",
                threadId: "thread-default",
                requestId: "approval-1",
                decision: "accept",
                createdAt: "2026-11-14T00:00:00.000Z",
              } as never).pipe(Effect.result);
              assert.equal(result._tag, "Failure");
              if (result._tag === "Failure")
                assert.include(JSON.stringify(result.failure), "scope");
              assert.equal(dispatched, 0);
            }),
          ),
        );
      }).pipe(Effect.provide(serverHttpTestLayer)),
    );
  }
});
