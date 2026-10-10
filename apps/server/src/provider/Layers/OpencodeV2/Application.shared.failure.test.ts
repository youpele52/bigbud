import { Effect, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { makeV2ApplicationRegistration } from "./Application.composition.ts";
import { readV2SharedApplicationConfig } from "./Application.shared.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";

vi.mock("./Application.shared.ts", () => ({ readV2SharedApplicationConfig: vi.fn() }));

for (const stage of ["health", "generation", "compatibility"] as const) {
  it(`retains the known installed version when shared ${stage} verification fails`, async () => {
    const message = `OpenCode v2 shared ${stage} verification failed; no work was submitted.`;
    vi.mocked(readV2SharedApplicationConfig).mockRejectedValue(
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
        Effect.provideService(ServerSettingsService, {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providers: {
              ...DEFAULT_SERVER_SETTINGS.providers,
              opencodeV2: {
                ...DEFAULT_SERVER_SETTINGS.providers.opencodeV2,
                enabled: true,
                connectionMode: "shared",
              },
            },
          }),
          streamChanges: Stream.never,
        } as unknown as typeof ServerSettingsService.Service),
        Effect.provideService(ProviderTurnAdmissions, {} as typeof ProviderTurnAdmissions.Service),
      ),
    );
  });
}
