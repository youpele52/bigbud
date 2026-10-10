import { Effect } from "effect";
import { expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { capturedModelSelectionError } from "../../../orchestration/Layers/ProviderCommandReactorSessionOps.settings.ts";
import { makeAdapterLookup } from "../ProviderAdapterRegistry.ts";
import { makeV2ApplicationRegistration } from "./Application.composition.ts";
import { makeIsolatedOpencodeV2Adapter } from "./Adapter.execution.ts";
import { makeDormantOpencodeV2Adapter } from "./Adapter.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

it("advertises the executing adapter's idle model switch through application registry, not dormant capabilities", async () => {
  await withV2RuntimeFixture(async ({ runtime }) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const registration = yield* makeV2ApplicationRegistration();
          const executing = yield* makeIsolatedOpencodeV2Adapter(runtime.options);
          const registry = makeAdapterLookup([registration.adapterService]);
          const registered = yield* registry.getByProvider("opencodeV2");
          const error = capturedModelSelectionError({
            activeSession: {
              provider: "opencodeV2",
              threadId: ThreadId.makeUnsafe("captured-wrapper-model"),
              model: "big-pickle",
              status: "ready",
              runtimeMode: "full-access",
              createdAt: "2026-10-10T00:00:00Z",
              updatedAt: "2026-10-10T00:00:00Z",
            },
            modelSelection: {
              provider: "opencodeV2",
              subProviderID: "opencode",
              model: "gpt-6.1-sol",
            },
            sessionModelSwitch: registered.capabilities.sessionModelSwitch,
            requireExactModel: true,
          });
          expect(error?.issue).toBeUndefined();
          expect(registered.capabilities).toEqual(executing.adapter.capabilities);
          expect(registered.capabilities.sessionModelSwitch).toBe("in-session");
          expect(makeDormantOpencodeV2Adapter().capabilities.sessionModelSwitch).toBe(
            "unsupported",
          );
          const disabled = yield* registered
            .startSession({
              threadId: ThreadId.makeUnsafe("disabled-still-rejected"),
              runtimeMode: "full-access",
            })
            .pipe(Effect.result);
          expect(disabled._tag).toBe("Failure");
        }),
      ).pipe(
        Effect.provide(ServerSettingsService.layerTest()),
        Effect.provideService(ProviderTurnAdmissions, runtime.options.journal),
      ),
    );
  });
});
