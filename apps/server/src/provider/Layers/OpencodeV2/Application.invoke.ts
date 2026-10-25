import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";
import type { OpencodeV2AdapterShape } from "../../Services/OpencodeV2/Adapter.ts";
import { ProviderAdapterValidationError } from "../../Errors.ts";
import type { V2ConsentAuthority } from "./Application.consent.ts";
import { runAuthorizedV2 } from "./Client.guard.ts";
import { withV2CallerAsyncContext } from "./Client.guard.async.ts";
import { v2SharedRegistrationFile } from "./SharedService.registration.ts";
import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";

/** The production facade owns its observer fiber, not an unconditional detached setup caller.
 * The adapter/coordinator retain separate physical and continuation ownership where required. */
export function makeV2ApplicationInvoke<EnsureError>(
  settings: Pick<ServerSettingsShape, "currentSnapshot">,
  consent: V2ConsentAuthority,
  ensure: Effect.Effect<{ adapter: OpencodeV2AdapterShape }, EnsureError>,
) {
  return function invoke<T, CallError>(
    run: (adapter: OpencodeV2AdapterShape) => Effect.Effect<T, CallError>,
  ) {
    return Effect.suspend(() => {
      const config = settings.currentSnapshot?.()?.settings.providers.opencodeV2;
      return Effect.tryPromise({
        try: (signal) =>
          runAuthorizedV2(
            consent,
            config && resolveOpencodeV2ConnectionMode(config) === "shared"
              ? config.serviceFile?.trim() || v2SharedRegistrationFile()
              : undefined,
            () =>
              Effect.runPromise(
                withV2CallerAsyncContext(
                  ensure.pipe(
                    Effect.flatMap((entry) =>
                      Effect.suspend(() => {
                        signal.throwIfAborted();
                        return run(entry.adapter);
                      }),
                    ),
                  ),
                ),
                { signal },
              ),
          ),
        catch: (error) =>
          Schema.is(ProviderAdapterValidationError)(error)
            ? error
            : new ProviderAdapterValidationError({
                provider: "opencodeV2",
                operation: "configuration",
                issue: error instanceof Error ? error.message : "V2 authorization unavailable.",
              }),
      });
    });
  };
}
