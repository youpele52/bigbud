import { writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { composeOptionalProviders } from "../OptionalProviderComposition.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { makeDormantOpencodeV2Adapter } from "./Adapter.ts";
import { makeDormantOpencodeV2Provider } from "./Provider.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { deferred, flushMicrotasks } from "./Test.fixtures.ts";

const inspect = vi.hoisted(() =>
  vi.fn<(_root: string, options?: { signal?: AbortSignal }) => Promise<void>>(),
);
vi.mock("./ProfileIsolation.mjs", () => ({ inspectPrivateV2Profile: inspect }));

it("overall inspection deadline makes V2 unavailable, retains CLIProxy, and fences late validation publication", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory }) => {
    const root = await realpath(runtime.options.config.profileRoot);
    await writeFile(
      path.join(root, ".bigbud-opencode-v2-development"),
      "bigbud-opencode-v2-disposable-v1\n",
      { mode: 0o600 },
    );
    const entered = deferred<void>();
    const late = deferred<void>();
    let signal: AbortSignal | undefined;
    inspect.mockImplementation(async (_root, options) => {
      signal = options?.signal;
      entered.resolve();
      await late.promise;
    });
    const cliProxy = {
      provider: "cliProxy" as const,
      adapterService: { ...makeDormantOpencodeV2Adapter(), provider: "cliProxy" as const },
      providerService: makeDormantOpencodeV2Provider(),
      capabilities: {
        supportsRemoteProviderRuntime: false,
        supportsLocalRuntimeRemoteWorkspace: true,
        toolInjectionMode: "mcp" as const,
        needsBuiltinsDisabled: true,
      },
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = Effect.runPromise(
        Effect.scoped(
          composeOptionalProviders([cliProxy], {
            BIGBUD_ENABLE_OPENCODE_V2_DEVELOPMENT: "1",
            BIGBUD_OPENCODE_V2_BINARY: path.join(root, "never-launch"),
            BIGBUD_OPENCODE_V2_PROFILE_ROOT: root,
            BIGBUD_OPENCODE_V2_WORKSPACE: directory,
          }),
        ).pipe(
          Effect.provideService(ProviderTurnAdmissions, runtime.options.journal),
          Effect.provideService(ServerSettingsService, {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              providers: {
                ...DEFAULT_SERVER_SETTINGS.providers,
                opencodeV2: { ...DEFAULT_SERVER_SETTINGS.providers.opencodeV2, enabled: true },
              },
            }),
          } as unknown as typeof ServerSettingsService.Service),
        ),
      );
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5001);
      const registrations = await pending;
      expect(signal?.aborted).toBe(true);
      expect(registrations[0]).toBe(cliProxy);
      expect(await Effect.runPromise(registrations[1]!.providerService.getSnapshot)).toMatchObject({
        enabled: false,
        models: [],
      });
      late.resolve();
      await flushMicrotasks();
      expect(await Effect.runPromise(registrations[1]!.providerService.getSnapshot)).toMatchObject({
        enabled: false,
        models: [],
      });
      expect(runtime.sessions.size).toBe(0);
    } finally {
      late.resolve();
      vi.useRealTimers();
      inspect.mockReset();
    }
  });
});
