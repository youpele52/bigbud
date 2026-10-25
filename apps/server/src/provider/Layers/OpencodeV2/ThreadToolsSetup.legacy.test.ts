import { readFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import * as artifacts from "./Orchestration.artifact.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadToolsSetup } from "./ThreadToolsSetup.ts";
import { ThreadToolsActivationLive } from "./ThreadToolsActivation.ts";
import { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";

const native = vi.hoisted(() => ({
  borrow: vi.fn(),
  config: vi.fn(),
  verify: vi.fn(),
  recover: vi.fn(),
}));
vi.mock("./SharedService.connection.ts", () => ({ borrowV2SharedService: native.borrow }));
vi.mock("./Application.shared.ts", () => ({ readV2SharedApplicationConfig: native.config }));
vi.mock("./Orchestration.readiness.ts", () => ({ verifyV2ThreadTools: native.verify }));
vi.mock("./RebootRecovery.setup.ts", () => ({ recoverV2RebootForSetup: native.recover }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each(["qualified", "runtime-checked"] as const)(
  "returns actual %s proof and qualification-aware readiness for the exact legacy artifact",
  async (evidenceKind) => {
    const app = await makeV2ThreadPluginFixture({ legacyRegistration: true });
    const manifestPath = path.join(app.artifact.directory, "manifest.json");
    const before = await readFile(manifestPath, "utf8");
    const close = vi.fn(async () => {});
    const client = {};
    const requestSetup = vi.spyOn(V2ThreadToolsActivation.prototype, "requestSetup");
    // Supply the retained artifact at the setup boundary; no native service is acquired by this test.
    vi.spyOn(artifacts, "exportV2ThreadArtifact").mockResolvedValueOnce(app.artifact);
    native.config.mockResolvedValue({ process: { sharedService: {} } });
    native.borrow.mockResolvedValue({ client, close });
    const proof: V2NativeRuntimeProof = {
      evidenceKind,
      assertCurrent: () => {},
      assertConfigRead: () => {},
      transport: "synthetic-transport",
      generation: "synthetic-generation",
      nativeVersion: "2.0.28",
      platform: "darwin",
      arch: "arm64",
      nativeContractDigest: "a".repeat(64),
      qualificationRecordId: "b".repeat(64),
      semanticProfile: "v2-global-config-v1",
      consumedApiDigest: "c".repeat(64),
      root: app.root,
      directory: app.root,
      consentRevision: 1,
      compatibilityDigest: app.artifact.compatibilityDigest,
    };
    native.verify.mockResolvedValue({ nativeProof: proof });
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const setup = yield* makeV2ThreadToolsSetup();
            return yield* setup.get({ refresh: true });
          }).pipe(Effect.provide(ThreadToolsActivationLive)),
        ).pipe(
          Effect.provideService(ServerConfig, {
            stateDir: app.root,
          } as typeof ServerConfig.Service),
          Effect.provide(
            ServerSettingsService.layerTest({
              ...DEFAULT_SERVER_SETTINGS,
              defaultChatCwd: app.root,
              providers: {
                ...DEFAULT_SERVER_SETTINGS.providers,
                opencodeV2: {
                  ...DEFAULT_SERVER_SETTINGS.providers.opencodeV2,
                  enabled: true,
                  connectionMode: "shared",
                  nativeServiceTrust: "managed-thread-tools-v2",
                  nativePluginConfigRoot: app.root,
                },
              },
            }),
          ),
        ),
      );
      expect(result).toMatchObject({
        status: "ready",
        activationState: "ready",
        directory: app.root,
        artifactDigest: app.artifact.artifactDigest,
        artifactDirectoryUri: app.artifact.pluginUri,
        configAddition: { plugins: [app.artifact.pluginUri] },
        nativeVersion: proof.nativeVersion,
        nativeContractDigest: proof.nativeContractDigest,
        semanticProfile: proof.semanticProfile,
        qualificationState: evidenceKind === "qualified" ? "qualified" : "unqualified",
        severity: "success",
      });
      expect(result.qualificationRecordId).toBe(
        evidenceKind === "qualified" ? proof.qualificationRecordId : undefined,
      );
      expect(result.message).toContain("Exact retained legacy bootstrap verified");
      expect(native.verify).toHaveBeenCalledExactlyOnceWith(
        app.artifact,
        client,
        app.root,
        expect.any(AbortSignal),
        undefined,
        expect.any(Function),
        app.root,
      );
      expect(close).toHaveBeenCalledOnce();
      expect(requestSetup).not.toHaveBeenCalled();
      expect(native.recover).not.toHaveBeenCalled();
      expect(await readFile(manifestPath, "utf8")).toBe(before);
    } finally {
      await app.close();
    }
  },
);
