import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { startOwnedV2Process } from "./ServerManager.child.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";
import { assertV2ModelAvailable } from "./Runtime.model.availability.ts";

const binaryPath = process.env.BIGBUD_OPENCODE_V2_TEST_BINARY;
// The only catalog test permitted to use the public network, explicitly opted in.
it.skipIf(!binaryPath || process.env.BIGBUD_OPENCODE_V2_PUBLIC_CATALOG_SMOKE !== "1")(
  "browses the full official catalog through production discovery on exact native 2.0.26 with no account",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bigbud-v2-catalog-native-")));
    const profileRoot = path.join(root, "profile");
    const workspace = path.join(root, "workspace");
    await mkdir(profileRoot, { mode: 0o700 });
    await mkdir(workspace);
    const config = { binaryPath: binaryPath!, profileRoot, runtimeTargetId: "local" };
    const owned = await startOwnedV2Process(config);
    const manager = new OpencodeV2ServerManager({
      maxProcesses: 1,
      maxOwners: 2,
      maxQueuedEvents: 4,
      maxEventBytes: 100000,
      consumerTimeoutMs: 1000,
      start: async () => owned,
    });
    try {
      const before = await owned.client.model.list({ location: { directory: workspace } });
      expect(before.data).toHaveLength(0);
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          opencodeV2: { enabled: true, binaryPath: binaryPath!, profileRoot },
        },
      };
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const provider = yield* makeV2DevelopmentProvider(
              { options: { manager } } as unknown as OpencodeV2Runtime,
              { process: config, workspace },
              true,
            );
            const result = yield* provider.refresh;
            expect(result.installed).toBe(true);
            expect(result.auth.status).toBe("unknown");
            expect(result.modelDiscovery?.status).toBe("live");
            expect(result.models.length).toBeGreaterThan(1000);
            expect(
              result.models.some(({ availability }) => availability === "requires-setup"),
            ).toBe(true);
            const selected = result.models.find(({ subProviderID }) => subProviderID === "openai")!;
            yield* Effect.promise(async () => {
              await expect(
                assertV2ModelAvailable(owned.client, workspace, {
                  providerID: selected.subProviderID!,
                  id: selected.slug,
                }),
              ).rejects.toThrow("No prompt or fallback was sent");
            });
            const nativeAfter = yield* Effect.promise(() =>
              owned.client.model.list({ location: { directory: workspace } }),
            );
            process.stdout.write(
              JSON.stringify({
                version: result.version,
                nativeBefore: before.data.length,
                browseableAfter: result.models.length,
                subproviders: new Set(result.models.map(({ subProviderID }) => subProviderID)).size,
                serializedModelBytes: Buffer.byteLength(JSON.stringify(result.models)),
                perProvider: Object.fromEntries(
                  ["openai", "anthropic", "google", "opencode", "opencode-go", "azure"].map(
                    (id) => [
                      id,
                      result.models.filter(({ subProviderID }) => subProviderID === id).length,
                    ],
                  ),
                ),
                auth: result.auth.status,
                nativeAfter: nativeAfter.data.length,
                nativeByProvider: Object.fromEntries(
                  [...new Set(nativeAfter.data.map(({ providerID }) => providerID))].map((id) => [
                    id,
                    nativeAfter.data.filter(({ providerID }) => providerID === id).length,
                  ]),
                ),
                prompts: 0,
              }) + "\n",
            );
          }).pipe(
            Effect.provideService(ServerSettingsService, {
              getSettings: Effect.succeed(settings),
            } as unknown as typeof ServerSettingsService.Service),
          ),
        ),
      );
    } finally {
      await manager.close();
      await owned.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
