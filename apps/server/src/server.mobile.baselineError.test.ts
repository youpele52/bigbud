/**
 * A baseline the server refuses as too large for mobile must reach the phone
 * with its own message, not a generic "failed to load", so the user is told
 * to open the thread on the desktop.
 */
import { MOBILE_RECOVERY_WS_METHODS } from "@bigbud/contracts/server/mobile.recovery";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { MOBILE_BASELINE_TOO_LARGE_MESSAGE } from "./mobile/mobileRecordBounds.ts";
import { mobileBaselineTooLargeError } from "./orchestration/Layers/ProjectionSnapshotQuery.mobileBudget.ts";
import { buildAppUnderTest, getWsServerUrl, serverTestLayer } from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";
import { withRetriedMobileWsRpcClient } from "./server.test.mobile.ts";

const session = {
  sessionId: "session-1",
  token: "token-1",
  scope: "thread-control" as const,
  createdAt: "2026-06-24T12:00:00.000Z",
  expiresAt: "2099-07-01T12:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  label: "iphone",
};

it.layer(serverTestLayer)("server router seam > mobile baseline errors", (it) => {
  it.effect("passes the too-large-for-mobile message through to the phone", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          mobileRemoteControl: { validateSessionToken: () => Effect.succeed(session) },
          projectionSnapshotQuery: {
            getMobileRecoveryBaseline: () => Effect.fail(mobileBaselineTooLargeError()),
          },
        },
      });

      const result = yield* Effect.scoped(
        withRetriedMobileWsRpcClient(yield* getWsServerUrl("/mobile-ws?token=token-1"), (client) =>
          client[MOBILE_RECOVERY_WS_METHODS.getBaseline]({ recoveryAttemptId: "too-large" }),
        ).pipe(Effect.result),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.equal(
        (result.failure as { readonly message?: string }).message,
        MOBILE_BASELINE_TOO_LARGE_MESSAGE,
      );
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
