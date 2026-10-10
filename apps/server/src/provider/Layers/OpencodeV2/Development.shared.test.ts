import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";

it("refreshes native account metadata without credential reads, preserves native models and keeps old qualified runtime ready", async () => {
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
      ...runtime.options.config,
      sharedService: {
        registrationFile: "/native/service.json",
        databasePath: runtime.options.config.profileRoot,
        storageIdentity: "native-db",
        generation: "native",
        binaryPath: "/native/opencode",
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
          expect(initial).toMatchObject({
            status: "ready",
            auth: { status: "unknown" },
            runtimeUpdateRecommended: "2.0.26",
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
          expect(refreshed.status).toBe("ready"); // Account unknown does not make configured/free models unusable.
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
