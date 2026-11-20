/**
 * WP-3D: client revision and identity boundaries of the remote client surface.
 *
 * Guidance is a two-step contract: every route refuses a missing or foreign client RPC revision
 * with 426 before any handler runs, while the revision-free authenticated handshake keeps
 * publishing the backend's revision so the client can show "Update required" instead of
 * retrying blindly.
 */
import {
  RemoteBackendClientHandshake,
  REMOTE_BACKEND_CLIENT_HANDSHAKE_REVISION,
  REMOTE_BACKEND_CLIENT_RPC_REVISION,
  REMOTE_BACKEND_CLIENT_RPC_REVISION_HEADER,
} from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import { CommandId, ORCHESTRATION_WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { getHttpServerUrl, serverTestLayer, withWsRpcClient } from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";
import {
  attemptRawUpgrade,
  makeRemoteBackendUnderTest,
  REMOTE_TEST_TOKEN,
  remoteWsUrl,
} from "./server.test.remote.ts";

const INCOMPATIBLE_BODY = "Incompatible remote client RPC revision";
const foreignRevision = String(REMOTE_BACKEND_CLIENT_RPC_REVISION + 1);

it.layer(serverTestLayer)("remote backend > client revisions", (it) => {
  it.effect("incompatible_revision_refused_with_guidance", () =>
    Effect.gen(function* () {
      yield* makeRemoteBackendUnderTest();
      const upgrade = (input: Parameters<typeof remoteWsUrl>[0]) =>
        remoteWsUrl(input).pipe(
          Effect.flatMap((url) => Effect.promise(() => attemptRawUpgrade(url))),
        );

      // A newer (or older) laptop is refused before the RPC socket opens.
      const foreign = yield* upgrade({ revision: foreignRevision });
      assert.deepStrictEqual(foreign, { upgraded: false, status: 426, body: INCOMPATIBLE_BODY });
      // A client that predates revision negotiation is refused the same way.
      const undeclared = yield* upgrade({ revision: null });
      assert.deepStrictEqual(undeclared, {
        upgraded: false,
        status: 426,
        body: INCOMPATIBLE_BODY,
      });
      // Authentication is checked first, so a revision refusal never confirms a guessed token.
      const unauthenticated = yield* upgrade({ revision: foreignRevision, token: "wrong" });
      assert.include(unauthenticated, { upgraded: false, status: 401 });

      // Non-socket routes share the same boundary.
      const routeUrl = yield* getHttpServerUrl("/attachments/any");
      const route = yield* Effect.promise(() =>
        fetch(routeUrl, {
          headers: {
            authorization: `Bearer ${REMOTE_TEST_TOKEN}`,
            [REMOTE_BACKEND_CLIENT_RPC_REVISION_HEADER]: foreignRevision,
          },
        }),
      );
      assert.equal(route.status, 426);
      assert.equal(yield* Effect.promise(() => route.text()), INCOMPATIBLE_BODY);

      // The guidance input stays reachable without declaring a revision.
      const handshakeUrl = yield* getHttpServerUrl("/api/remote-backend/handshake");
      const handshakeResponse = yield* Effect.promise(() =>
        fetch(handshakeUrl, { headers: { authorization: `Bearer ${REMOTE_TEST_TOKEN}` } }),
      );
      assert.equal(handshakeResponse.status, 200);
      const handshake = Schema.decodeUnknownSync(RemoteBackendClientHandshake)(
        yield* Effect.promise(() => handshakeResponse.json()),
      );
      assert.equal(handshake.handshakeRevision, REMOTE_BACKEND_CLIENT_HANDSHAKE_REVISION);
      assert.equal(handshake.clientRpcRevision, REMOTE_BACKEND_CLIENT_RPC_REVISION);
      assert.notEqual(String(handshake.clientRpcRevision), foreignRevision);

      // Refusing one laptop never changes what the backend accepts from a matching one.
      const matching = yield* upgrade({});
      assert.include(matching, { upgraded: true, status: 101 });
      const compatibleUrl = yield* remoteWsUrl();
      const outcome = yield* withWsRpcClient(compatibleUrl, (client) =>
        client[ORCHESTRATION_WS_METHODS.getCommandOutcome]({
          commandId: CommandId.makeUnsafe("cmd-never-sent"),
        }),
      );
      assert.include(outcome, { status: "unknown" });
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );

  // Gap: the remote backend has no key or client-credential rotation to fence against yet.
  // `loadRemoteBackendIdentity` (authority.ts) always mints `keyEpoch: 1` and nothing raises it;
  // `ServerConfig.authToken` is fixed for the process lifetime, so there is no rotation event
  // that could invalidate an open `/ws` socket or mark frames sent under the old key as late.
  // Client-side pin comparison (`compareRemoteBackendIdentity` → "key-rotated") only refuses a
  // new connection. Implement once rotation exists: rotate mid-stream, then assert frames
  // (domain-event batches and acks) carried by the pre-rotation socket are dropped and that
  // socket is closed.
  it.todo("late_frame_after_key_rotation_dropped");
});
