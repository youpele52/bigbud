import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Random } from "effect";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { AnalyticsService } from "../../../telemetry/Services/AnalyticsService.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../ProviderService.ts";
import { ProviderAdapterRegistry } from "../../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../../Services/ProviderService.ts";
import { ClaudeAdapter } from "../../Services/Claude/Adapter.ts";
import { makeClaudeAdapterLive } from "./Adapter.ts";
import {
  FakeClaudeQuery,
  makeDeterministicRandomService,
  readFirstPromptText,
  THREAD_ID,
} from "./Adapter.test.helpers.ts";

describe("Claude exhausted-query provider routing", () => {
  it.effect(
    "creates a fresh resumed Query only for the next explicit turn, without resending the uncertain prompt",
    () => {
      const inputs: Array<{ prompt: AsyncIterable<SDKUserMessage>; options: Options }> = [];
      const queries = [new FakeClaudeQuery(), new FakeClaudeQuery()];
      const settings = ServerSettingsService.layerTest();
      const claude = makeClaudeAdapterLive({
        createQuery: (input) => {
          inputs.push(input);
          const query = queries[inputs.length - 1];
          if (!query) throw new Error("Unexpected implicit query restart");
          return query;
        },
      }).pipe(
        Layer.provideMerge(settings),
        Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-routing-test", "/tmp")),
        Layer.provideMerge(NodeServices.layer),
      );
      const registry = Layer.effect(
        ProviderAdapterRegistry,
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          return {
            listProviders: () => Effect.succeed(["claudeAgent" as const]),
            getByProvider: () => Effect.succeed(adapter),
          };
        }),
      ).pipe(Layer.provideMerge(claude));
      const directory = ProviderSessionDirectoryLive.pipe(
        Layer.provide(
          ProviderSessionRuntimeRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
        ),
      );
      const layer = makeProviderServiceLive().pipe(
        Layer.provideMerge(registry),
        Layer.provide(directory),
        Layer.provide(settings),
        Layer.provide(AnalyticsService.layerTest),
      );
      return Effect.gen(function* () {
        const provider = yield* ProviderService;
        const adapter = yield* ClaudeAdapter;
        yield* provider.startSession(THREAD_ID, {
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        yield* provider.sendTurn({
          threadId: THREAD_ID,
          input: "uncertain prompt",
          attachments: [],
        });
        assert.equal(inputs.length, 1);
        assert.equal(
          yield* Effect.promise(() => readFirstPromptText(inputs[0])),
          "uncertain prompt",
        );
        const nativeId = inputs[0]!.options.sessionId;
        assert.isString(nativeId);
        queries[0]!.fail(new Error("transport ended after accepting input"));
        for (let attempt = 0; attempt < 100 && (yield* adapter.hasSession(THREAD_ID)); attempt++)
          yield* Effect.yieldNow;
        assert.isFalse(yield* adapter.hasSession(THREAD_ID));
        assert.equal(inputs.length, 1);
        assert.equal(queries[0]!.reinitializeCalls.length, 0);
        assert.equal(queries[0]!.closeCalls, 1);
        yield* provider.sendTurn({
          threadId: THREAD_ID,
          input: "explicit next turn",
          attachments: [],
        });
        assert.equal(inputs.length, 2);
        assert.equal(inputs[1]!.options.resume, nativeId);
        assert.isUndefined(inputs[1]!.options.sessionId);
        assert.equal(inputs[1]!.options.permissionMode, "default");
        assert.equal(
          yield* Effect.promise(() => readFirstPromptText(inputs[1])),
          "explicit next turn",
        );
        assert.isTrue(yield* adapter.hasSession(THREAD_ID));
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(layer),
      );
    },
  );
});
