import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { makeV2ActivatedFixtureRegistration as makeV2ApplicationRegistration } from "./Application.activation.fixture.ts";
import { discoverV2SharedService } from "./SharedService.discovery.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";
import { sharedServiceTestRegistration } from "./SharedService.test.fixture.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";

vi.mock("./SharedService.discovery.ts", () => ({ discoverV2SharedService: vi.fn() }));

it("healthy preconsent refresh reports native version but never acquires a manager or lazy SSE", async () => {
  const fixture = await sharedServiceTestRegistration();
  const acquire = vi.spyOn(OpencodeV2ServerManager.prototype, "acquire");
  try {
    vi.mocked(discoverV2SharedService).mockResolvedValue({
      registration: await readV2SharedRegistration(fixture.file),
      version: "2.0.24",
      generation: "fixture",
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registration = yield* makeV2ApplicationRegistration();
          const snapshot = yield* registration.providerService.refresh;
          expect(snapshot).toMatchObject({
            installed: true,
            version: "2.0.24",
            models: [],
            status: "warning",
            auth: { status: "unknown" },
          });
          expect(snapshot.message).toContain("consent required");
          expect(acquire).not.toHaveBeenCalled();
        }),
      ).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            providers: {
              opencodeV2: { enabled: true, connectionMode: "shared", serviceFile: fixture.file },
            },
          }),
        ),
        Effect.provideService(ProviderTurnAdmissions, {} as typeof ProviderTurnAdmissions.Service),
      ),
    );
  } finally {
    acquire.mockRestore();
    await fixture.close();
  }
});

for (const stage of ["health", "generation", "compatibility"] as const) {
  it(`retains the known installed version when shared ${stage} verification fails`, async () => {
    const message = `OpenCode v2 shared ${stage} verification failed; no work was submitted.`;
    vi.mocked(discoverV2SharedService).mockRejectedValue(
      new V2SharedServiceError(stage, message, "2.0.24"),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registration = yield* makeV2ApplicationRegistration();
          expect(yield* registration.providerService.refresh).toMatchObject({
            enabled: true,
            installed: true,
            version: "2.0.24",
            status: "warning",
            message,
          });
        }),
      ).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            providers: { opencodeV2: { enabled: true, connectionMode: "shared" } },
          }),
        ),
        Effect.provideService(ProviderTurnAdmissions, {} as typeof ProviderTurnAdmissions.Service),
      ),
    );
  });
}
