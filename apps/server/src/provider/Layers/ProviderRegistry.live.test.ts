import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProvider } from "@bigbud/contracts";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Exit, Layer, Scope } from "effect";

import { checkCodexProviderStatus } from "./Codex/Provider";
import { haveProvidersChanged, makeProviderRegistryLive } from "./ProviderRegistry";
import { OpencodeServerManager } from "../Services/Opencode/ServerManager";
import { ProviderRegistry } from "../Services/ProviderRegistry";
import { ServerSettingsService } from "../../ws/serverSettings";

import {
  failingSpawnerLayer,
  fakePiProviderLayer,
  makeMutableServerSettingsService,
  mockCommandSpawnerLayer,
  mockOpencodeServerManagerLayer,
} from "./ProviderRegistry.test.helpers";

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsService.layerTest()))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it("treats equal provider snapshots as unchanged", () => {
        const providers = [
          {
            provider: "codex",
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
          {
            provider: "claudeAgent",
            status: "warning",
            enabled: true,
            installed: true,
            auth: { status: "unknown" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;

        assert.strictEqual(haveProvidersChanged(providers, [...providers]), false);
      });

      it("treats checkedAt-only refreshes as unchanged", () => {
        const providers = [
          {
            provider: "codex",
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;

        assert.strictEqual(
          haveProvidersChanged(providers, [
            {
              ...providers[0],
              checkedAt: "2026-03-25T00:01:00.000Z",
            },
          ]),
          false,
        );
      });

      it.effect("reruns codex health when codex provider settings change", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService();
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = makeProviderRegistryLive({
            piProviderLayer: fakePiProviderLayer,
          }).pipe(
            Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
            Layer.provideMerge(mockOpencodeServerManagerLayer),
            Layer.provideMerge(
              mockCommandSpawnerLayer((command, args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  if (command === "codex") {
                    return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
                  }
                  return { stdout: "", stderr: "spawn ENOENT", code: 1 };
                }
                if (joined === "login status") {
                  return { stdout: "Logged in\n", stderr: "", code: 0 };
                }
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );
          const runtimeServices = yield* Layer.build(
            Layer.mergeAll(
              Layer.succeed(ServerSettingsService, serverSettings),
              providerRegistryLayer,
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;

            // Initial probes run asynchronously after layer construction.
            // Poll until codex is ready (or exhaust attempts).
            let initial: ReadonlyArray<ServerProvider> = [];
            for (let attempt = 0; attempt < 20; attempt += 1) {
              initial = yield* registry.getProviders;
              if (initial.find((p) => p.provider === "codex")?.status === "ready") break;
              yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
            }
            assert.strictEqual(
              initial.find((status) => status.provider === "codex")?.status,
              "ready",
            );

            yield* serverSettings.updateSettings({
              providers: {
                codex: {
                  binaryPath: "/custom/codex",
                },
              },
            });

            for (let attempt = 0; attempt < 20; attempt += 1) {
              const updated = yield* registry.getProviders;
              if (updated.find((status) => status.provider === "codex")?.status === "error") {
                return;
              }
              yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
            }

            const updated = yield* registry.getProviders;
            assert.strictEqual(
              updated.find((status) => status.provider === "codex")?.status,
              "error",
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("does not block initial provider snapshots when OpenCode startup fails", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService();
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = makeProviderRegistryLive({
            piProviderLayer: fakePiProviderLayer,
          }).pipe(
            Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
            Layer.provideMerge(
              Layer.succeed(OpencodeServerManager, {
                acquire: () => Promise.reject(new Error("spawn opencode ENOENT")),
              }),
            ),
            Layer.provideMerge(
              mockCommandSpawnerLayer((command, args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  if (command === "codex") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
                  return { stdout: "", stderr: "spawn ENOENT", code: 1 };
                }
                if (joined === "login status") {
                  return { stdout: "Logged in\n", stderr: "", code: 0 };
                }
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );
          const runtimeServices = yield* Layer.build(
            Layer.mergeAll(
              Layer.succeed(ServerSettingsService, serverSettings),
              providerRegistryLayer,
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;

            const initial = yield* registry.getProviders;
            assert.deepStrictEqual(initial, []);

            for (let attempt = 0; attempt < 20; attempt += 1) {
              const providers = yield* registry.getProviders;
              const codexStatus = providers.find(
                (provider) => provider.provider === "codex",
              )?.status;
              const opencodeStatus = providers.find(
                (provider) => provider.provider === "opencode",
              )?.status;
              if (codexStatus === "ready" && opencodeStatus === "error") {
                return;
              }
              yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
            }

            const providers = yield* registry.getProviders;
            assert.strictEqual(
              providers.find((provider) => provider.provider === "codex")?.status,
              "ready",
            );
            assert.strictEqual(
              providers.find((provider) => provider.provider === "opencode")?.status,
              "error",
            );
            assert.strictEqual(
              providers.find((provider) => provider.provider === "opencode")?.message,
              "OpenCode binary is not installed or not on PATH.",
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("skips codex probes entirely when the provider is disabled", () =>
        Effect.gen(function* () {
          const serverSettingsLayer = ServerSettingsService.layerTest({
            providers: {
              codex: {
                enabled: false,
              },
            },
          });

          const status = yield* checkCodexProviderStatus().pipe(
            Effect.provide(
              Layer.mergeAll(serverSettingsLayer, failingSpawnerLayer("spawn codex ENOENT")),
            ),
          );
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.enabled, false);
          assert.strictEqual(status.status, "disabled");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.message, "Codex is disabled in bigbud settings.");
        }),
      );
    });
  },
);
