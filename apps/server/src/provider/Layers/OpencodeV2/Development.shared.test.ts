import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";
import { opencodeUpdateAdvice } from "@bigbud/shared/opencodeAdvisory";

it("refreshes native account metadata without credential reads, preserves native models and tells an outdated runtime to update", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    vi.spyOn(http.client.server, "info").mockResolvedValue({ version: "2.0.24" } as Awaited<
      ReturnType<typeof http.client.server.info>
    >);
    vi.spyOn(http.client.provider, "list").mockResolvedValue({ location: { directory }, data: [] });
    vi.spyOn(http.client.agent, "list").mockResolvedValue({ location: { directory }, data: [] });
    vi.spyOn(http.client.skill, "list").mockResolvedValue({ location: { directory }, data: [] });
    const integration = vi
      .spyOn(http.client.integration, "list")
      .mockResolvedValue({ location: { directory }, data: [] });
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
          const initial = yield* provider.refresh;
          // An outdated service stays usable; amber carries the update advice.
          expect(initial).toMatchObject({
            status: "warning",
            auth: { status: "unknown" },
            runtimeUpdateRecommended: "2.1.4",
          });
          expect(initial.message).toBe(
            `Connected to your native OpenCode service. ${opencodeUpdateAdvice("2.0.24", "2.1.4")}`,
          );
          expect(initial.models.length).toBeGreaterThan(0);
          expect(initial.models.every((model) => model.availability === "available")).toBe(true);
          integration.mockResolvedValue({
            location: { directory },
            data: [
              {
                id: "openai",
                name: "OpenAI",
                methods: [],
                connections: [
                  {
                    type: "credential",
                    id: "native-account",
                    label: "Native account",
                    method: "oauth",
                  },
                ],
              },
            ],
          });
          expect((yield* provider.refresh).auth).toEqual({
            status: "authenticated",
            label: "OpenAI",
          });
          integration.mockResolvedValue({
            location: { directory },
            data: [
              {
                id: "openai",
                name: "OpenAI",
                methods: [],
                connections: [
                  {
                    type: "credential",
                    id: "native-account",
                    label: "Native account",
                    method: "oauth",
                    status: { status: "needs_auth", message: "Reconnect" },
                  },
                ],
              },
            ],
          });
          const refreshed = yield* provider.refresh;
          expect(refreshed.auth).toEqual({ status: "unknown" });
          // Account unknown does not make configured/free models unusable; only the update advice remains.
          expect(refreshed.status).toBe("warning");
          expect(refreshed.message).toBe(initial.message);
          expect(refreshed.models).toEqual(initial.models);
          expect(http.calls.some((call) => /credential|connect/.test(call.pathname))).toBe(false);
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

it("keeps the update advice when an outdated service has no native models", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    vi.spyOn(http.client.server, "info").mockResolvedValue({ version: "2.0.28" } as Awaited<
      ReturnType<typeof http.client.server.info>
    >);
    vi.spyOn(http.client.model, "list").mockResolvedValue({
      location: { directory },
      data: [],
    } as unknown as Awaited<ReturnType<typeof http.client.model.list>>);
    for (const list of [http.client.provider, http.client.agent, http.client.skill])
      vi.spyOn(list, "list").mockResolvedValue({ location: { directory }, data: [] } as never);
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
    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(
          makeV2DevelopmentProvider(
            runtime,
            { process: config, workspace: directory },
            true,
            async () => ({
              models: [],
              stale: false,
            }),
          ),
          (provider) => provider.refresh,
        ),
      ).pipe(
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
    expect(snapshot).toMatchObject({ status: "warning", runtimeUpdateRecommended: "2.1.4" });
    expect(snapshot.message).toBe(
      `No native models are available. Connect a provider in OpenCode; bigbud detects account changes automatically. ${opencodeUpdateAdvice("2.0.28", "2.1.4")}`,
    );
  });
});
