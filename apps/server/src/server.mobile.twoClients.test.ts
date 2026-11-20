/**
 * Two phones paired with one host hold independent sessions: both read the
 * same canonical state, and revoking one closes only that phone's socket.
 */
import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";

import { realMobileRemoteControl } from "./server.mobile.gateway.fixtures.ts";
import {
  buildAppUnderTest,
  getWsServerUrl,
  makeDefaultOrchestrationReadModel,
  serverTestLayer,
} from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";
import { withMobileWsRpcClient } from "./server.test.mobile.ts";

it.layer(serverTestLayer)("server router seam > two mobile clients", (it) => {
  it.effect("keeps two paired phones independent under revocation", () =>
    Effect.gen(function* () {
      const mobile = yield* realMobileRemoteControl;
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: mobile,
          projectionSnapshotQuery: {
            getMobileRecoveryBaseline: () =>
              Effect.succeed({
                snapshot: makeDefaultOrchestrationReadModel(),
                snapshotSequence: 0,
                selectedThread: null,
              }),
          },
        },
      });
      const pairPhone = (label: string) =>
        Effect.gen(function* () {
          const pairing = yield* mobile.createPairing({
            scope: "thread-control",
            baseUrl: "https://desk.ts.net/mobile",
            backendBaseUrl: "https://desk.ts.net",
          });
          return yield* mobile.exchangePairing({
            pairingId: pairing.pairingId,
            secret: pairing.secret,
            label,
          });
        });
      const phoneA = yield* pairPhone("phone-a");
      const phoneB = yield* pairPhone("phone-b");
      const urlFor = (token: string) =>
        getWsServerUrl(`/mobile-ws?token=${encodeURIComponent(token)}`);
      const urlB = yield* urlFor(phoneB.token);

      // Phone B stays connected across phone A's revocation.
      const scopeB = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scopeB, Exit.void));
      const outcome = yield* withMobileWsRpcClient(urlB, (clientB) =>
        Effect.gen(function* () {
          const beforeB = yield* clientB[ORCHESTRATION_WS_METHODS.getSnapshot]({});
          const afterRevokeA = yield* Effect.scoped(
            withMobileWsRpcClient(yield* urlFor(phoneA.token), (clientA) =>
              Effect.gen(function* () {
                const beforeA = yield* clientA[ORCHESTRATION_WS_METHODS.getSnapshot]({});
                // Both phones read the same canonical state.
                assert.deepStrictEqual(
                  beforeA.threads.map((thread) => thread.id),
                  beforeB.threads.map((thread) => thread.id),
                );
                yield* mobile.revokeSession(phoneA.sessionId);
                return yield* clientA[ORCHESTRATION_WS_METHODS.getSnapshot]({}).pipe(
                  Effect.timeout("5 seconds"),
                  Effect.result,
                );
              }),
            ),
          );
          const afterB = yield* clientB[ORCHESTRATION_WS_METHODS.getSnapshot]({});
          return { afterRevokeA, afterB };
        }),
      ).pipe(Scope.provide(scopeB));

      assert.equal(outcome.afterRevokeA._tag, "Failure");
      assert.include(
        String(outcome.afterRevokeA._tag === "Failure" && outcome.afterRevokeA.failure),
        '"code":4401',
      );
      assert.isAtLeast(outcome.afterB.threads.length, 1);
      const active = (yield* mobile.listSessions).filter((session) => session.revokedAt === null);
      assert.deepStrictEqual(
        active.map((session) => session.sessionId),
        [phoneB.sessionId],
      );
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
