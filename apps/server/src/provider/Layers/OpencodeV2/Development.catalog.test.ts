import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2DevelopmentProvider } from "./Development.provider.ts";
import { normalizeV2PublicCatalog } from "./Catalog.public.ts";

it("publishes the full catalog with no native model/account, then retains browsing with truthful refresh failure", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const models = normalizeV2PublicCatalog({
      openai: {
        id: "openai",
        name: "OpenAI",
        models: {
          coder: { id: "coder", name: "Friendly Coder" },
        },
      },
    });
    const info = vi
      .spyOn(http.client.server, "info")
      .mockResolvedValue({ version: "2.0.26" } as Awaited<
        ReturnType<typeof http.client.server.info>
      >);
    vi.spyOn(http.client.provider, "list").mockResolvedValue({ location: { directory }, data: [] });
    vi.spyOn(http.client.model, "list").mockResolvedValue({ location: { directory }, data: [] });
    const load = vi.fn(async () => ({ models, stale: false }));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* makeV2DevelopmentProvider(
            runtime,
            { process: runtime.options.config, workspace: directory },
            true,
            load,
          );
          expect((yield* provider.getSnapshot).initialProbeComplete).toBe(false);
          const result = yield* provider.refresh;
          expect(result.models).toEqual(models);
          expect(result).toMatchObject({
            installed: true,
            auth: { status: "unknown" },
            initialProbeComplete: true,
          });
          expect(result.message).toContain("accounts are not verified");
          info.mockRejectedValue(new Error("private native details"));
          const failed = yield* provider.refresh;
          expect(failed.models).toEqual(models);
          expect(failed.status).toBe("warning");
          expect(failed.message).toContain("No fallback");
          expect(JSON.stringify(failed)).not.toContain("private native details");
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
