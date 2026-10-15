import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { makeV2ActivatedFixtureRegistration as makeV2ApplicationRegistration } from "./Application.activation.fixture.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { OpencodeV2SharedBindings } from "../../../persistence/Services/OpencodeV2SharedBindings.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { V2_SHARED_DOWNGRADE_WARNING } from "./Application.rollback.ts";

it("common enabled:false blocks acquisition/dispatch without consent/new fields, and exposes the durable-history downgrade warning", async () => {
  const acquire = vi.spyOn(OpencodeV2ServerManager.prototype, "acquire");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registration = yield* makeV2ApplicationRegistration();
          const snapshot = yield* registration.providerService.refresh;
          expect(snapshot.enabled).toBe(false);
          expect(snapshot.message).toContain(V2_SHARED_DOWNGRADE_WARNING);
          const start = yield* Effect.result(
            registration.adapterService.startSession({
              threadId: ThreadId.makeUnsafe("disabled-old-compatible"),
              runtimeMode: "approval-required",
            }),
          );
          expect(start._tag).toBe("Failure");
          expect(acquire).not.toHaveBeenCalled();
        }),
      ).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({ providers: { opencodeV2: { enabled: false } } }),
        ),
        Effect.provideService(ProviderTurnAdmissions, {} as typeof ProviderTurnAdmissions.Service),
        Effect.provideService(OpencodeV2SharedBindings, {
          hasRecords: Effect.succeed(true),
          find: () => Effect.succeed(undefined),
          reserve: () => Effect.die("Disabled fixture must not reserve history"),
          transition: () => Effect.die("Disabled fixture must not transition history"),
        }),
      ),
    );
  } finally {
    acquire.mockRestore();
  }
});
