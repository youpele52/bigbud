import { assert, it } from "@effect/vitest";
import { WsRpcGroup } from "@bigbud/contracts/server/rpc.ts";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

import { buildAppUnderTest, serverTestLayer } from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";

it("does not expose marketplace RPC methods", () => {
  assert.isFalse([...WsRpcGroup.requests.keys()].some((method) => method.startsWith("plugins.")));
});

it.layer(serverTestLayer)("retired marketplace HTTP surface", (it) => {
  it.effect("uses the ordinary missing-web fallback instead of an artwork handler", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const response = yield* HttpClient.get(
        "/api/plugins/assets?scope=installed&revision=old&pluginId=old&assetKey=logo",
      );
      assert.equal(response.status, 503);
      assert.equal(yield* response.text, "No static directory configured and no dev URL set.");
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
