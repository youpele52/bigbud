/**
 * WP-4C: D10 setup authority over the real WebSocket routes. The laptop client on the
 * authenticated remote client socket passes the authority middleware (the update service is not
 * composed here, so it reports `unavailable`); a local-backend connection is refused
 * `unauthorized` before any handler runs. Mobile has no route to these RPCs at all (see
 * `remote-backend/runtimeUpdate.authority.test.ts`).
 */
import { WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  buildAppUnderTest,
  getWsServerUrl,
  serverTestLayer,
  withWsRpcClient,
} from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";
import { makeRemoteBackendUnderTest, remoteWsUrl } from "./server.test.remote.ts";

const statusError = (url: string) =>
  Effect.scoped(
    withWsRpcClient(url, (client) =>
      client[WS_METHODS.serverGetRemoteRuntimeUpdateStatus]({}).pipe(Effect.flip),
    ),
  );

it.layer(serverTestLayer)("remote backend > runtime update authority", (it) => {
  it.effect("laptop_client_socket_has_setup_authority", () =>
    Effect.gen(function* () {
      yield* makeRemoteBackendUnderTest();
      const error = yield* statusError(yield* remoteWsUrl());
      assert.include(error, { _tag: "RemoteRuntimeUpdateError", code: "unavailable" });
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );

  it.effect("local_backend_connection_denied_server_side", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const error = yield* statusError(yield* getWsServerUrl("/ws"));
      assert.include(error, { _tag: "RemoteRuntimeUpdateError", code: "unauthorized" });
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
