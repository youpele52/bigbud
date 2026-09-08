import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { ServerConfig } from "@bigbud/contracts/server/server.ts";
import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";

import {
  buildAppUnderTest,
  getWsServerUrl,
  serverTestLayer,
  withRetriedWsRpcClient,
} from "./server.test.helpers.ts";
import { buildPiModels } from "./provider/Layers/Pi/Provider.utils.ts";

it.layer(serverTestLayer)("server router seam > Pi config wire", (it) => {
  it.effect("serves canonical Pi names through unary config and snapshot streams", () =>
    Effect.gen(function* () {
      const models = buildPiModels(
        [
          {
            id: "google/gemma-4-26b-a4b",
            name: "Google: Gemma 4 26B A4B ",
            provider: "openrouter",
          },
        ],
        [],
      );
      const providers = [
        {
          provider: "pi",
          enabled: true,
          installed: true,
          version: "0.52.9",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-08-30T00:00:00.000Z",
          models,
          slashCommands: [],
          skills: [],
        },
      ] as const satisfies ReadonlyArray<ServerProvider>;

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
            streamChanges: Stream.empty,
          },
          providerRegistry: { getProviders: Effect.succeed(providers) },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withRetriedWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const unary = yield* client[WS_METHODS.serverGetConfig]({});
            const snapshots = yield* client[WS_METHODS.subscribeServerConfig]({}).pipe(
              Stream.take(1),
              Stream.runCollect,
            );
            const ping = yield* client[WS_METHODS.serverPing]({});
            return { unary, snapshot: Array.from(snapshots)[0], ping };
          }),
        ),
      );

      assert.isTrue(Schema.is(ServerConfig)(result.unary));
      assert.equal(result.unary.providers[0]?.models[0]?.name, "Google: Gemma 4 26B A4B");
      assert.equal(result.unary.providers[0]?.models[0]?.slug, "google/gemma-4-26b-a4b");
      assert.equal(result.unary.providers[0]?.models[0]?.subProviderID, "openrouter");
      assert.equal(result.snapshot?.type, "snapshot");
      if (result.snapshot?.type === "snapshot") {
        assert.isTrue(Schema.is(ServerConfig)(result.snapshot.config));
        assert.equal(
          result.snapshot.config.providers[0]?.models[0]?.name,
          "Google: Gemma 4 26B A4B",
        );
      }
      assert.match(result.ping.serverTime, /^\d{4}-\d{2}-\d{2}T/);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
