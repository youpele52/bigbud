import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";
import { v2SharedDiscoveryFailure } from "./Development.provider.diagnostics.ts";
import { V2HttpStatusError } from "./Client.errors.ts";
import { OPENCODE_UNQUALIFIED_RUNTIME_WARNING } from "@bigbud/shared/opencodeAdvisory";

it("never exposes native error messages, credentials or response bodies in discovery diagnostics", () => {
  const error = Object.assign(new Error("private prompt-body secret token"), {
    status: 500,
    body: "authorization: secret",
  });
  const message = v2SharedDiscoveryFailure("model.list", "/fixture/location", error);
  expect(message).toContain('model.list for Location "/fixture/location"');
  expect(message).toContain("not proof of a disconnected account");
  expect(message).not.toMatch(/secret|prompt-body|authorization|HTTP 500/);
});

it.each(["model.list", "provider.list", "integration.list", "agent.list", "skill.list"] as const)(
  "identifies %s failure and the exact discovery Location while failing cached availability closed",
  async (phase) => {
    await withV2RuntimeFixture(async ({ runtime: fixture, http, directory }) => {
      const options = sharedV2FixtureOptions(fixture, http);
      const runtime = new OpencodeV2Runtime(options);
      try {
        vi.spyOn(http.client.server, "info").mockResolvedValue({ version: "2.0.24" } as Awaited<
          ReturnType<typeof http.client.server.info>
        >);
        const provider = vi
          .spyOn(http.client.provider, "list")
          .mockResolvedValue({ location: { directory }, data: [] });
        const integration = vi
          .spyOn(http.client.integration, "list")
          .mockResolvedValue({ location: { directory }, data: [] });
        const agent = vi
          .spyOn(http.client.agent, "list")
          .mockResolvedValue({ location: { directory }, data: [] });
        const skill = vi
          .spyOn(http.client.skill, "list")
          .mockResolvedValue({ location: { directory }, data: [] });
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const discovery = yield* makeV2DevelopmentProvider(
                runtime,
                {
                  process: options.config,
                  workspace: directory,
                },
                true,
                async () => ({ models: [], stale: false }),
              );
              const healthy = yield* discovery.refresh;
              // Unqualified runtimes stay usable with an amber disclosure (10-14 plan §1a).
              expect(healthy.status).toBe("warning");
              expect(healthy.message).toContain(OPENCODE_UNQUALIFIED_RUNTIME_WARNING);
              expect(healthy.models.length).toBeGreaterThan(0);
              expect(healthy.models.every((model) => model.availability === "available")).toBe(
                true,
              );
              if (phase === "model.list") http.modelHttpFailures.set(directory, 500);
              else
                ({
                  "provider.list": provider,
                  "integration.list": integration,
                  "agent.list": agent,
                  "skill.list": skill,
                })[phase].mockRejectedValue(new V2HttpStatusError(500));
              const failed = yield* discovery.refresh;
              expect(failed.status).toBe("warning");
              expect(failed.auth.status).toBe("unknown");
              expect(failed.models).toHaveLength(healthy.models.length);
              expect(failed.models.every((model) => model.availability === "requires-setup")).toBe(
                true,
              );
              expect(failed.message).toContain(`${phase} (HTTP 500)`);
              expect(failed.message).not.toContain(OPENCODE_UNQUALIFIED_RUNTIME_WARNING);
              expect(failed.message).toContain(JSON.stringify(directory));
              expect(failed.message).toContain("not proof of a disconnected account");
              expect(http.calls.some((call) => call.method !== "GET")).toBe(false);
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
      } finally {
        vi.restoreAllMocks();
        await runtime.close();
      }
    });
  },
);
