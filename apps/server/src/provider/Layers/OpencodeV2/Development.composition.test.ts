import { chmod, writeFile, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Stream } from "effect";
import { expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@bigbud/contracts";
import { composeOptionalProviders } from "../OptionalProviderComposition.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { V2_DEVELOPMENT_MARKER } from "./Development.config.ts";
import { makeDormantOpencodeV2Adapter } from "./Adapter.ts";
import { makeDormantOpencodeV2Provider } from "./Provider.ts";

it("disabled flag preserves registrations; missing configuration remains nonblocking and cannot execute", async () => {
  await withV2RuntimeFixture(async ({ runtime }) => {
    const previous = [
      {
        provider: "cliProxy" as const,
        adapterService: { ...makeDormantOpencodeV2Adapter(), provider: "cliProxy" as const },
        providerService: makeDormantOpencodeV2Provider(),
        capabilities: {
          supportsRemoteProviderRuntime: false,
          supportsLocalRuntimeRemoteWorkspace: true,
          toolInjectionMode: "mcp" as const,
          needsBuiltinsDisabled: true,
        },
      },
    ];
    const check = Effect.scoped(
      Effect.gen(function* () {
        const app = yield* composeOptionalProviders(previous, {});
        expect(app[0]).toBe(previous[0]);
        expect(app[1]?.provider).toBe("opencodeV2");
        expect((yield* app[1]!.providerService.getSnapshot).developmentOnly).toBeUndefined();
        const registrations = yield* composeOptionalProviders(previous, {
          BIGBUD_ENABLE_OPENCODE_V2_DEVELOPMENT: "1",
        });
        expect(registrations[0]).toBe(previous[0]);
        const v2 = registrations[1]!;
        const snapshot = yield* v2.providerService.getSnapshot;
        expect(snapshot.enabled).toBe(false);
        expect(snapshot.models).toEqual([]);
        const result = yield* v2.adapterService
          .startSession({
            threadId: ThreadId.makeUnsafe("missing"),
            runtimeMode: "approval-required",
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }),
    );
    await Effect.runPromise(
      check.pipe(
        Effect.provideService(ProviderTurnAdmissions, runtime.options.journal),
        Effect.provideService(ServerSettingsService, {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
        } as unknown as typeof ServerSettingsService.Service),
      ),
    );
  });
});

it("disabled settings never launch a configured executable; unknown versions fail closed", async () => {
  await withV2RuntimeFixture(async ({ runtime, directory }) => {
    const root = await realpath(runtime.options.config.profileRoot);
    await writeFile(path.join(root, V2_DEVELOPMENT_MARKER), "bigbud-opencode-v2-disposable-v1\n");
    const binary = path.join(root, "unknown.mjs");
    const launched = path.join(root, "launches");
    await writeFile(
      binary,
      `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(launched)}, 'launch\\n');\nconsole.log('2.0.20');\n`,
    );
    await chmod(binary, 0o700);
    const environment = {
      BIGBUD_ENABLE_OPENCODE_V2_DEVELOPMENT: "1",
      BIGBUD_OPENCODE_V2_BINARY: binary,
      BIGBUD_OPENCODE_V2_PROFILE_ROOT: root,
      BIGBUD_OPENCODE_V2_WORKSPACE: directory,
    };
    const enabled = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencodeV2: { ...DEFAULT_SERVER_SETTINGS.providers.opencodeV2, enabled: true },
      },
    };
    for (const settings of [DEFAULT_SERVER_SETTINGS, enabled]) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const registrations = yield* composeOptionalProviders([], environment);
            const v2 = registrations[0]!;
            const snapshot = yield* v2.providerService.refresh;
            expect(snapshot.enabled).toBe(settings.providers.opencodeV2.enabled);
            expect(snapshot.models).toEqual([]);
            if (!settings.providers.opencodeV2.enabled)
              yield* Effect.promise(async () => {
                await expect(readFile(launched)).rejects.toThrow();
              });
            const outside = yield* v2.adapterService
              .startSession({
                threadId: ThreadId.makeUnsafe("outside"),
                cwd: root,
                runtimeMode: "approval-required",
              })
              .pipe(Effect.result);
            expect(outside._tag).toBe("Failure");
            const start = yield* v2.adapterService
              .startSession({
                threadId: ThreadId.makeUnsafe("version-fence"),
                cwd: directory,
                runtimeMode: "approval-required",
                modelSelection: {
                  provider: "opencodeV2",
                  subProviderID: "synthetic",
                  model: "synthetic-model",
                },
              })
              .pipe(Effect.result);
            expect(start._tag).toBe("Failure");
            if (start._tag === "Failure" && !settings.providers.opencodeV2.enabled)
              expect(start.failure.message).toContain("disabled");
          }).pipe(
            Effect.provideService(ProviderTurnAdmissions, runtime.options.journal),
            Effect.provideService(ServerSettingsService, {
              getSettings: Effect.succeed(settings),
            } as unknown as typeof ServerSettingsService.Service),
          ),
        ),
      );
    }
  });
});
