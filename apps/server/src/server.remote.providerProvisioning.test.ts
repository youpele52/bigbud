/**
 * WP-5C: provider provisioning over the real remote client socket route. The laptop client has
 * setup authority, so the provision action reaches its handler; a user provider only ever
 * reports state and manual commands (nothing is installed or started). Viewer refusal is covered
 * in `provider-provisioning/provisionAuthority.test.ts`; mobile has no route to these RPCs.
 */
import { WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { serverTestLayer, withWsRpcClient } from "./server.test.helpers.ts";
import { serverHttpTestLayer } from "./server.test.http.ts";
import { makeRemoteBackendUnderTest, remoteWsUrl } from "./server.test.remote.ts";
import { PROVIDER_RECIPES } from "./provider-provisioning/recipes/index.ts";

it.layer(serverTestLayer)("remote backend > provider provisioning", (it) => {
  it.effect("laptop_client_reads_status_and_provisions_a_user_provider", () =>
    Effect.gen(function* () {
      yield* makeRemoteBackendUnderTest();
      const url = yield* remoteWsUrl();
      const { status, result } = yield* Effect.scoped(
        withWsRpcClient(url, (client) =>
          Effect.gen(function* () {
            const status = yield* client[WS_METHODS.serverGetProviderProvisioningStatus]({
              provider: "devin",
            });
            const result = yield* client[WS_METHODS.serverProvisionProvider]({ provider: "devin" });
            return { status, result };
          }),
        ),
      );
      // Scoped to one user provider: a Copilot status read would touch the host runtime root.
      assert.deepStrictEqual(
        status.providers.map((entry) => entry.provider),
        ["devin"],
      );
      assert.strictEqual(result.entry.provider, "devin");
      assert.notStrictEqual(result.outcome, "installing");
      assert.isNull(result.copilotJob);
      assert.deepStrictEqual(
        result.entry.manualCommands,
        PROVIDER_RECIPES.devin.manual.installCommands,
      );
    }).pipe(Effect.provide(serverHttpTestLayer)),
  );
});
