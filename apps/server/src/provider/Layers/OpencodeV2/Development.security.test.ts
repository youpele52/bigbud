import { mkdtemp, realpath, mkdir, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { readV2DevelopmentConfig, V2_DEVELOPMENT_MARKER } from "./Development.config.ts";
import { inspectPrivateV2Profile } from "./ProfileIsolation.mjs";
import { composeOptionalProviders } from "../OptionalProviderComposition.ts";
import { makeDormantOpencodeV2Adapter } from "./Adapter.ts";
import { makeDormantOpencodeV2Provider } from "./Provider.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

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

it.skipIf(process.platform === "win32")(
  "rejects marked writable roots/config/plugin replacement before any executable launch, retaining CLIProxy",
  async () => {
    await withV2RuntimeFixture(async ({ runtime, directory }) => {
      const root = await realpath(runtime.options.config.profileRoot);
      const config = path.join(root, "config");
      const plugin = path.join(config, "opencode", "plugins", "synthetic.mjs");
      await mkdir(path.dirname(plugin), { recursive: true, mode: 0o700 });
      await writeFile(plugin, "// synthetic disposable plugin\n", { mode: 0o600 });
      await writeFile(
        path.join(root, V2_DEVELOPMENT_MARKER),
        "bigbud-opencode-v2-disposable-v1\n",
        { mode: 0o600 },
      );
      const binary = path.join(root, "never-launch.mjs");
      const launches = path.join(root, "launches");
      await writeFile(
        binary,
        `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(launches)}, 'unsafe launch');console.log('2.0.26');`,
        { mode: 0o700 },
      );
      const environment = {
        BIGBUD_ENABLE_OPENCODE_V2_DEVELOPMENT: "1",
        BIGBUD_OPENCODE_V2_BINARY: binary,
        BIGBUD_OPENCODE_V2_PROFILE_ROOT: root,
        BIGBUD_OPENCODE_V2_WORKSPACE: directory,
      };
      expect((await readV2DevelopmentConfig(environment)).workspace).toBe(
        await realpath(directory),
      );
      for (const [filename, mode, restore] of [
        [root, 0o777, 0o700],
        [root, 0o770, 0o700],
        [config, 0o777, 0o700],
        [config, 0o770, 0o700],
        [plugin, 0o666, 0o600],
      ] as const) {
        await chmod(filename, mode);
        try {
          await expect(readV2DevelopmentConfig(environment)).rejects.toThrow();
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const registrations = yield* composeOptionalProviders(previous, environment);
                expect(registrations[0]).toBe(previous[0]);
                expect((yield* registrations[1]!.providerService.getSnapshot).enabled).toBe(false);
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
          await expect(readFile(launches)).rejects.toThrow();
        } finally {
          await chmod(filename, restore);
        }
      }
    });
  },
);

it.skipIf(process.platform === "win32")(
  "accepts private/sticky temp ancestry but rejects replaceable nonsticky parents; streams a bounded tree",
  async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-parent-policy-")));
    const root = path.join(parent, "profile");
    try {
      await mkdir(root, { mode: 0o700 });
      await writeFile(
        path.join(root, V2_DEVELOPMENT_MARKER),
        "bigbud-opencode-v2-disposable-v1\n",
        { mode: 0o600 },
      );
      await inspectPrivateV2Profile(root);
      const getuid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
      try {
        await expect(inspectPrivateV2Profile(root)).rejects.toThrow("owner");
      } finally {
        getuid.mockRestore();
      }
      await chmod(parent, 0o1777);
      await inspectPrivateV2Profile(root);
      await chmod(parent, 0o777);
      await expect(inspectPrivateV2Profile(root)).rejects.toThrow("writable");
      await chmod(parent, 0o700);
      for (let i = 0; i < 5; i++)
        await writeFile(path.join(root, `entry-${i}`), "synthetic", { mode: 0o600 });
      await expect(inspectPrivateV2Profile(root, { maxEntries: 4 })).rejects.toThrow("bound");
      await expect(inspectPrivateV2Profile(root, { signal: AbortSignal.abort() })).rejects.toThrow(
        "cancelled",
      );
      await expect(inspectPrivateV2Profile(root, { timeoutMs: 0 })).rejects.toThrow("timed out");
    } finally {
      await chmod(parent, 0o700);
      await rm(parent, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "a FIFO ownership marker cannot block aggregate optional composition or CLIProxy",
  async () => {
    await withV2RuntimeFixture(async ({ runtime, directory }) => {
      const root = await realpath(runtime.options.config.profileRoot);
      const marker = path.join(root, V2_DEVELOPMENT_MARKER);
      await promisify(execFile)("mkfifo", ["-m", "600", marker]);
      // The fallback safely unblocks a regressed blocking open, making failure finite instead of hanging Vitest.
      const fallback = setTimeout(() => {
        void writeFile(marker, "invalid FIFO").catch(() => {});
      }, 1500);
      const start = performance.now();
      try {
        const registrations = await Effect.runPromise(
          Effect.scoped(
            composeOptionalProviders(previous, {
              BIGBUD_ENABLE_OPENCODE_V2_DEVELOPMENT: "1",
              BIGBUD_OPENCODE_V2_BINARY: path.join(root, "never-launch"),
              BIGBUD_OPENCODE_V2_PROFILE_ROOT: root,
              BIGBUD_OPENCODE_V2_WORKSPACE: directory,
            }),
          ).pipe(
            Effect.provideService(ProviderTurnAdmissions, runtime.options.journal),
            Effect.provideService(ServerSettingsService, {
              getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            } as unknown as typeof ServerSettingsService.Service),
          ),
        );
        expect(performance.now() - start).toBeLessThan(1000);
        expect(registrations[0]).toBe(previous[0]);
        expect(
          await Effect.runPromise(registrations[1]!.providerService.getSnapshot),
        ).toMatchObject({ enabled: false });
      } finally {
        clearTimeout(fallback);
      }
    });
  },
);

it.skipIf(process.platform !== "win32")(
  "fails closed rather than guessing Windows profile ACL isolation",
  async () => {
    await expect(inspectPrivateV2Profile("C:\\synthetic-profile")).rejects.toThrow(
      "ACL isolation cannot be proven",
    );
  },
);
