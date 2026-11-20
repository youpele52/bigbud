import { assertMobileGatewaySelectedBinding } from "../remote-agent/mobileGatewayLifecycle.binding.state.ts";
import { Effect, Schema } from "effect";
import * as Data from "effect/Data";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { withMobilePublicationOwner } from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import { currentMobileGatewayBinding } from "../remote-agent/mobileGatewayLifecycle.binding.ts";
import { remoteAgentBuildId } from "../remote-agent/remoteAgentRuntime.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";
import {
  MobileGatewayConfiguration,
  validateMobileGatewayConfiguration,
} from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { selectMobileGatewayDesired } from "../remote-agent/mobileGatewayActivation.selection.transitions.ts";

class MobileGatewaySelectionError extends Data.TaggedError("MobileGatewaySelectionError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Only the original publication proof selects files; request fields never grant path authority. */
export function commitMobileGatewayDesiredSelection(
  proof: VerifiedMobilePublication,
  requestId: string,
  configuration: MobileGatewayConfiguration,
) {
  return Effect.gen(function* () {
    const selectedConfiguration = yield* Effect.try({
      try: () => {
        const snapshot = Schema.decodeUnknownSync(MobileGatewayConfiguration)(configuration, {
          onExcessProperty: "error",
        });
        validateMobileGatewayConfiguration(snapshot);
        return Object.freeze(snapshot);
      },
      catch: (cause) =>
        new MobileGatewaySelectionError({
          message: "Canonical mobile gateway selection is invalid.",
          cause,
        }),
    });
    const settings = yield* ServerSettingsService;
    const owners = yield* RemoteAgentRuntimeOwners;
    return yield* Effect.tryPromise({
      try: (external) =>
        withMobilePublicationOwner(
          proof,
          async ({ authority, paths }, owned) => {
            const signal = AbortSignal.any([external, owned]);
            const binding = await currentMobileGatewayBinding(authority, owners, signal);
            const assertBinding = async () => {
              signal.throwIfAborted();
              const current = await owners.getBinding(
                localSupervisorTarget(authority.pin.authority.authorityId),
              );
              if (
                !current ||
                remoteAgentBuildId(current.runtime) !== binding.buildId ||
                current.runtime.generation !== binding.generation ||
                current.expectedEpoch !== binding.epoch ||
                current.connectionId !== binding.connectionId
              )
                throw Error("Canonical P4 binding changed during desired selection.");
            };
            if (!settings.withSnapshotBarrier) throw Error("Current settings barrier is required.");
            return Effect.runPromise(
              settings.withSnapshotBarrier((snapshot) =>
                Effect.tryPromise({
                  try: async (barrierSignal) => {
                    const combined = AbortSignal.any([signal, barrierSignal]);
                    if (!snapshot.settings.mobileRemoteControl.enabled)
                      throw Error("Mobile settings are disabled.");
                    await assertBinding();
                    await authority.assertAuthority();
                    combined.throwIfAborted();
                    const next = await authority.registry(combined).update((state) => {
                      assertMobileGatewaySelectedBinding(state, binding);
                      return selectMobileGatewayDesired(
                        state,
                        {
                          owner: authority.pin,
                          expectedConsentRevision: paths.consentRevision,
                          stageId: paths.stageId,
                          releaseId: paths.releaseId,
                        },
                        { requestId, configuration: selectedConfiguration },
                      );
                    });
                    await assertBinding();
                    combined.throwIfAborted();
                    if (next.schemaVersion !== 3 || !next.mobile.desired)
                      throw Error("Desired selection CAS acknowledgement is unavailable.");
                    return next.mobile.desired;
                  },
                  catch: (cause) =>
                    new MobileGatewaySelectionError({
                      message: "Current mobile gateway selection could not be committed.",
                      cause,
                    }),
                }),
              ),
              { signal },
            );
          },
          external,
        ),
      catch: (cause) =>
        cause instanceof MobileGatewaySelectionError
          ? cause
          : new MobileGatewaySelectionError({
              message: "Original mobile publication selection is unavailable.",
              cause,
            }),
    });
  });
}
