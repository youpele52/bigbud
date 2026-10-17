import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { OPENCODE_UNQUALIFIED_RUNTIME_WARNING } from "@bigbud/shared/opencodeAdvisory";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";
import { syntheticV2QualificationRecord } from "./NativeCompatibility.qualification.fixture.ts";

const registry = vi.hoisted(() => ({ passes: [] as unknown[], failures: [] as unknown[] }));
vi.mock("./NativeCompatibility.qualification.registry.ts", () => ({
  V2_NATIVE_RELEASE_QUALIFICATIONS: registry.passes,
  V2_NATIVE_RELEASE_INCOMPATIBILITIES: registry.failures,
}));
afterEach(() => {
  registry.passes.length = 0;
  registry.failures.length = 0;
  vi.restoreAllMocks();
});

it("reports a qualified shared runtime as ready without the unqualified disclosure", async () => {
  // Evidence is keyed by [version, platform, arch]; match the host so CI runners resolve it too.
  registry.passes.push({
    ...syntheticV2QualificationRecord("2.0.24"),
    platform: process.platform,
    arch: process.arch,
  });
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    vi.spyOn(http.client.server, "info").mockResolvedValue({ version: "2.0.24" } as Awaited<
      ReturnType<typeof http.client.server.info>
    >);
    vi.spyOn(http.client.provider, "list").mockResolvedValue({ location: { directory }, data: [] });
    vi.spyOn(http.client.agent, "list").mockResolvedValue({ location: { directory }, data: [] });
    vi.spyOn(http.client.skill, "list").mockResolvedValue({ location: { directory }, data: [] });
    vi.spyOn(http.client.integration, "list").mockResolvedValue({
      location: { directory },
      data: [],
    });
    const config = {
      runtimeTargetId: "local",
      sharedService: {
        registrationFile: "/native/service.json",
        storageIdentity: "native-db",
        generation: "native",
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeV2DevelopmentProvider(
            runtime,
            { process: config, workspace: directory },
            true,
            async () => ({ models: [], stale: false }),
          );
          const snapshot = yield* provider.refresh;
          expect(snapshot).toMatchObject({
            status: "ready",
            auth: { status: "unknown" },
            runtimeUpdateRecommended: "2.0.26",
            message: "Connected to your native OpenCode service.",
          });
          expect(snapshot.message).not.toContain(OPENCODE_UNQUALIFIED_RUNTIME_WARNING);
          expect(snapshot.models.length).toBeGreaterThan(0);
          expect(snapshot.models.every((model) => model.availability === "available")).toBe(true);
        }).pipe(
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
      ),
    );
  });
});
