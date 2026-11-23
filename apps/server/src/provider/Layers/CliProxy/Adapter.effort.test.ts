import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  createInvocationFixture,
  spawnBridge,
} from "../../../orchestration-tools/mcpInvocationIdentity.testSupport.ts";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { CliProxyAdapter } from "../../Services/CliProxy/Adapter.ts";
import { CliProxyLifecycle } from "../../Services/CliProxy/Lifecycle.ts";
import { FakeClaudeQuery } from "../Claude/Adapter.test.helpers.query.ts";
import type { ClaudeAdapterLiveOptions } from "../Claude/Adapter.ts";
import { getClaudeModelCapabilities } from "../Claude/Provider.ts";
import { makeCliProxyAdapterLive } from "./Adapter.ts";
import { decodeModels } from "./Client.ts";

describe("CLIProxy native effort forwarding", () => {
  it.each([undefined, "xhigh"])(
    "preserves startup effort unless the turn selects %s",
    async (effort) => {
      const model = "proxy-effort-test-model";
      const models = decodeModels({
        models: [
          {
            slug: model,
            supported_reasoning_levels: [
              { effort: "low" },
              { effort: "high" },
              { effort: "xhigh" },
            ],
            default_reasoning_level: "high",
          },
        ],
      });
      const capabilities = models[0]!.capabilities!;
      const query = new FakeClaudeQuery();
      let options:
        | Parameters<NonNullable<ClaudeAdapterLiveOptions["createQuery"]>>[0]["options"]
        | undefined;
      const layer = (port: number) =>
        makeCliProxyAdapterLive({
          createQuery: (input) => {
            options = input.options;
            return query;
          },
          resolveRuntimeConfig: () =>
            Effect.succeed({
              config: {
                baseUrl: new URL("http://127.0.0.1:8317"),
                apiKey: "mock",
                configPath: "/tmp/mock.yaml",
              },
              models,
              harness: {
                binaryPath: "claude",
                modelCapabilities: capabilities,
                settingSources: [],
              },
            }),
        }).pipe(
          Layer.provideMerge(
            Layer.effect(
              ServerConfig,
              Effect.map(Effect.service(ServerConfig), (config) => ({ ...config, port })),
            ).pipe(
              Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "bigbud-cliproxy-effort-" })),
            ),
          ),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(
            Layer.succeed(CliProxyLifecycle, {
              isClaudeRunnable: async () => ({ _tag: "available" }) as const,
              activate: async () => ({ _tag: "started", reused: false }) as const,
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
        );
      await Effect.runPromise(
        Effect.gen(function* () {
          const http = yield* Effect.acquireRelease(
            Effect.promise(() =>
              createInvocationFixture(async () => ({ ok: true, result: { accepted: true } })),
            ),
            (fixture) => Effect.promise(fixture.close),
          );
          yield* Effect.gen(function* () {
            const adapter = yield* CliProxyAdapter;
            const threadId = ThreadId.makeUnsafe("cliproxy-effort");
            const invalid = yield* adapter
              .startSession({
                threadId,
                provider: "cliProxy",
                runtimeMode: "full-access",
                modelSelection: { provider: "cliProxy", model, options: { effort: "ultrathink" } },
              })
              .pipe(Effect.result);
            expect(invalid._tag).toBe("Failure");
            expect(options).toBeUndefined();
            yield* adapter.startSession({
              threadId,
              provider: "cliProxy",
              runtimeMode: "full-access",
              modelSelection: { provider: "cliProxy", model, options: { effort: "low" } },
            });
            expect(options?.model).toBe(model);
            expect(options?.effort).toBe("low");
            expect(options?.mcpServers).toHaveProperty("bigbud_orchestration");
            expect(options?.allowedTools).toContain(
              "mcp__bigbud_orchestration__list_available_models",
            );
            expect(options?.allowedTools).not.toContain("mcp__bigbud_orchestration__create_thread");
            const mcp = options?.mcpServers?.bigbud_orchestration;
            if (!mcp || !("command" in mcp))
              throw new Error("CLIProxy did not configure a stdio MCP bridge");
            yield* Effect.promise(async () => {
              const bridge = spawnBridge(mcp);
              try {
                const modelSelection = { provider: "cliProxy", model, effort: "xhigh" };
                const result = await bridge.send({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: {
                    name: "create_thread",
                    arguments: { title: "Worker", task: "Synthetic task", modelSelection },
                  },
                });
                expect(JSON.stringify(result)).toContain("accepted");
                expect(http.requests).toEqual([
                  expect.objectContaining({ action: "create_thread", modelSelection }),
                ]);
              } finally {
                await bridge.close();
              }
            });
            yield* adapter.sendTurn({
              threadId,
              input: "hello",
              ...(effort
                ? { modelSelection: { provider: "cliProxy" as const, model, options: { effort } } }
                : {}),
            });
            expect(query.applyFlagSettingsCalls).toEqual(effort ? [{ effortLevel: effort }] : []);
            expect(getClaudeModelCapabilities(model).reasoningEffortLevels).toEqual([]);
            yield* adapter.stopAll();
          }).pipe(Effect.provide(layer(http.port)));
        }).pipe(Effect.scoped),
      );
    },
  );
});
