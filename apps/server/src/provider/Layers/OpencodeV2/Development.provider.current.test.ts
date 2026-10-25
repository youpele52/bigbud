import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";
import { opencodeAgentSystemHash } from "../../opencodeAgentSource.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

// Release qualification evidence is not a readiness gate: a supported or newer service is ready.
it.each(["2.1.4", "2.2.0"])(
  "reports a shared %s runtime as ready with no update notice",
  async (version) => {
    await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
      vi.spyOn(http.client.server, "info").mockResolvedValue({ version } as Awaited<
        ReturnType<typeof http.client.server.info>
      >);
      vi.spyOn(http.client.provider, "list").mockResolvedValue({
        location: { directory },
        data: [],
      });
      vi.spyOn(http.client.agent, "list").mockResolvedValue({
        location: { directory },
        data: [
          {
            id: "babysitter",
            name: "babysitter",
            system: "Watch the task.",
            request: { settings: {}, headers: {}, body: {} },
            mode: "subagent",
            hidden: false,
            permissions: [],
          },
        ],
      });
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
              message: "Connected to your native OpenCode service.",
            });
            expect(snapshot.runtimeUpdateRecommended).toBeUndefined();
            expect(snapshot.nativeAgents).toEqual([
              {
                id: "babysitter",
                name: "babysitter",
                systemPromptHash: opencodeAgentSystemHash("Watch the task."),
              },
            ]);
            expect(JSON.stringify(snapshot.nativeAgents)).not.toContain("Watch the task.");
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
  },
);
