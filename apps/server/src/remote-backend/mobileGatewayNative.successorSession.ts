import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { withMobilePublicationTeardown } from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { mobileRegistryOwnerEqual } from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import type {
  ConfirmedNativeLeaseExit,
  NativeServiceLeaseClient,
  PendingOriginalNativeLease,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import {
  acquireManagedNativeLeaseChannel,
  managedNativeLeaseChannel,
} from "./localSupervisorService.leaseChannel.ts";
import {
  acquireMobileGatewayActivationAuthority,
  type MobileGatewayActivationAuthority,
} from "./mobileGatewayActivation.authority.ts";
import type { RemoteMobileNativeInputsValue } from "./mobileGatewayActivation.inputs.ts";
import type { NativeMobileActivationOutcome } from "./mobileGatewayActivation.launch.ts";
import { withNativeMobilePublication } from "./mobileGatewayActivation.publication.ts";
import { makeMobileSuccessorUpstream } from "./mobileGatewayActivation.successor.native.ts";
import { validateMobileGatewayListener } from "./mobileGatewayListener.prefix.ts";
import {
  restoreNativeMobileGatewayLease,
  selectNativeMobileSuccessor,
  type NativeMobileSuccessorCandidate,
} from "./mobileGatewayNative.restore.ts";
import {
  settledNativeMobileWork,
  type NativeMobileGatewaySessionSignals,
} from "./mobileGatewayNative.session.ts";
import {
  adoptNativeMobileSuccessor,
  type NativeMobileSuccessorOutcome,
} from "./mobileGatewayNative.successor.ts";
import { recordNativeMobileSuccessorExit } from "./mobileGatewayNative.successorExit.ts";
import { nativeMobileGatewayProcessPort } from "./mobileGatewayOwner.port.ts";
import type { MobileActivationReason } from "./mobileGatewayActivation.reason.ts";
import {
  readNativeMobileHostEvidence,
  settleEndedNativeMobileAttempt,
} from "./mobileGatewayNative.resolve.ts";
import { adoptNativeMobileSuccessorController } from "./mobileGatewayNative.successorAdopt.ts";

class NativeMobileSuccessorRestoreError extends Data.TaggedError(
  "NativeMobileSuccessorRestoreError",
)<{ readonly message: string; readonly cause: unknown }> {}
const failed = (
  cause: unknown,
  repairRequired: boolean,
  reason?: MobileActivationReason,
): NativeMobileSuccessorOutcome => ({
  kind: "failed",
  repairRequired,
  cause,
  ...(reason ? { reason } : {}),
});
/** Canonical journal consent for exactly this attempt's owner and consent revision. */
export function nativeMobileSuccessorConsented(
  state: RemoteAgentRegistry,
  candidate: NativeMobileSuccessorCandidate,
): boolean {
  return (
    state.schemaVersion === 3 &&
    mobileRegistryOwnerEqual(state.mobile.owner, candidate.owner) &&
    state.mobile.consent.enabled &&
    state.mobile.consent.revision === candidate.attempt.consentRevision
  );
}
interface Adopted {
  readonly authority: MobileGatewayActivationAuthority;
  readonly candidate: NativeMobileSuccessorCandidate;
  readonly client: NativeServiceLeaseClient;
  readonly pending: PendingOriginalNativeLease;
  readonly consented: (signal: AbortSignal) => Promise<boolean>;
  readonly signals: NativeMobileGatewaySessionSignals;
}
const settle = (work: (interrupted: AbortSignal) => Promise<NativeMobileActivationOutcome>) =>
  settledNativeMobileWork(work).pipe(
    Effect.catch((cause) => Effect.succeed(failed(cause, true) as NativeMobileActivationOutcome)),
  );

/**
 * Consent is on: hold the reminted publication of the attempt's own stage, then the same listener
 * prefix, consent-off subscription and sealed upstream helper as a fresh session. Readiness hands
 * off to the shared owner over the native process port; exits are recorded through the
 * publication authority registry.
 */
const adoptWithPublication = Effect.fn("adoptNativeMobileSuccessorWithPublication")(function* (
  proof: VerifiedMobilePublication,
  adopted: Adopted,
  lifetime: AbortSignal,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const { authority, candidate, client, pending, signals } = adopted;
      const original = candidate.attempt.nativeOwnership;
      const listener = yield* validateMobileGatewayListener(proof);
      const assertAllowed = async () => {
        await authority.assertAuthority();
        await listener.assertAllowed();
      };
      const consentOff = new AbortController();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          listener.onSnapshotChange((snapshot) => {
            if (!snapshot.settings.mobileRemoteControl.enabled)
              consentOff.abort(Error("Mobile consent settings revoked."));
          }),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const serveUpstream = yield* makeMobileSuccessorUpstream(assertAllowed);
      const runOwner = Effect.runPromiseWith(
        yield* Effect.services<
          RemoteAgentRuntimeOwners | RemoteBackendIdentityService | ServerSettingsService
        >(),
      );
      const selected = Object.freeze({
        nonce: original.binding.nonce,
        ...candidate.attempt.configuration,
      });
      const recordExit = (exit: ConfirmedNativeLeaseExit, signal: AbortSignal) =>
        withMobilePublicationTeardown(proof, (owner, owned) =>
          recordNativeMobileSuccessorExit(
            { pin: owner.pin, registry: (current) => owner.registry(current) },
            client,
            pending,
            original,
            exit,
            AbortSignal.any([signal, owned]),
          ),
        );
      return yield* settle((interrupted) =>
        adoptNativeMobileSuccessor({
          ...adopted,
          signals: {
            detach: AbortSignal.any([signals.detach, lifetime, interrupted]),
            stop: AbortSignal.any([signals.stop, consentOff.signal]),
          },
          serveUpstream,
          recordExit,
          use: async (lease, upstream, signal) => {
            // Durable adoption first: owner admission requires this instance as the current one.
            await adoptNativeMobileSuccessorController(proof, candidate, signal);
            return runOwner(
              listener.gateway
                .runWith(proof, selected, nativeMobileGatewayProcessPort(lease, signal))
                .pipe(Effect.provideService(ServerConfig, upstream.config)),
            );
          },
        }),
      );
    }),
  );
});

/**
 * Successor recovery at controller attach, default-off with the controller. Order: activation
 * authority → canonical journal read → select at most one foreign `attempted` native row → managed
 * lease channel → restore the retained intent (`onAdopted`) → recovery. With journal consent on,
 * the attempt's stage is reminted and readiness reaches the shared owner; with it off, the
 * recovery can only revoke: native stop, then a journal-only exit through the activation authority
 * registry (no publication exists to remint). Release: owner admission, native stop/detach, then
 * upstream, publication, and the channel last.
 */
export const runNativeMobileSuccessor = Effect.fn("runNativeMobileSuccessor")(function* (
  inputs: RemoteMobileNativeInputsValue,
  signals: NativeMobileGatewaySessionSignals,
  onAdopted: () => void,
) {
  const acquired = yield* Effect.exit(acquireMobileGatewayActivationAuthority);
  if (Exit.isFailure(acquired)) return { kind: "unavailable" } as NativeMobileSuccessorOutcome;
  const authority = acquired.value;
  const read = (signal: AbortSignal) =>
    authority.registry(AbortSignal.any([signal, signals.detach])).read();
  const initial = yield* Effect.exit(Effect.tryPromise(read));
  if (Exit.isFailure(initial)) return failed(initial.cause, false, "journal-unreadable");
  const selection = selectNativeMobileSuccessor(initial.value, authority.owner);
  if (selection.kind === "none") return { kind: "none" } as NativeMobileSuccessorOutcome;
  if (selection.kind === "conflict")
    return failed(
      Error("Several foreign native mobile originals require owner repair."),
      true,
      "successor-conflict",
    );
  const candidate = selection;
  const identity = yield* RemoteBackendIdentityService;
  const owners = yield* RemoteAgentRuntimeOwners;
  const host = yield* Effect.exit(
    Effect.tryPromise(() => readNativeMobileHostEvidence(owners, authority.pin)),
  );
  // A lease of an earlier supervisor epoch cannot be resumed: only proven death settles it.
  if (
    Exit.isSuccess(host) &&
    host.value.epoch !== candidate.attempt.nativeOwnership.binding.nativeEpoch
  ) {
    const settled = yield* Effect.exit(
      Effect.tryPromise((signal) =>
        authority
          .registry(AbortSignal.any([signal, signals.detach]))
          .update((state) =>
            settleEndedNativeMobileAttempt(
              state,
              authority.pin,
              candidate.attempt.nonce,
              host.value,
              Date.now(),
            ),
          ),
      ),
    );
    return Exit.isSuccess(settled)
      ? ({ kind: "exit-recorded" } as NativeMobileSuccessorOutcome)
      : failed(settled.cause, true, "native-epoch-ended-unproven");
  }
  const run = Effect.runPromiseWith(
    yield* Effect.services<Effect.Services<ReturnType<typeof adoptWithPublication>>>(),
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const channel = yield* Effect.exit(acquireManagedNativeLeaseChannel());
      if (Exit.isFailure(channel))
        return failed(channel.cause, true, "successor-channel-unavailable");
      const client = managedNativeLeaseChannel(channel.value).client;
      // An older Rust epoch, a foreign owner or a non-canonical row is refused here: repair.
      const restored = yield* Effect.exit(
        Effect.try({
          try: () =>
            restoreNativeMobileGatewayLease(
              client,
              identity,
              candidate.owner,
              candidate.attempt.nativeOwnership,
            ),
          catch: (cause) =>
            new NativeMobileSuccessorRestoreError({
              message: "The retained native original could not be restored.",
              cause,
            }),
        }),
      );
      if (Exit.isFailure(restored))
        return failed(restored.cause, true, "successor-restore-refused");
      const pending = restored.value;
      onAdopted();
      const consented = async (signal: AbortSignal) =>
        nativeMobileSuccessorConsented(await read(signal), candidate);
      const adopted: Adopted = {
        authority,
        candidate,
        client,
        pending,
        consented,
        signals,
      };
      const on = yield* Effect.exit(Effect.tryPromise(consented));
      if (Exit.isSuccess(on) && on.value) {
        const published = yield* Effect.exit(
          withNativeMobilePublication(
            inputs.trustedKeys,
            signals.detach,
            (publisher) =>
              publisher.remint(candidate.attempt.stageId, candidate.attempt.consentRevision),
            (proof, lifetime) => run(adoptWithPublication(proof, adopted, lifetime)),
          ),
        );
        return Exit.isSuccess(published)
          ? published.value
          : failed(published.cause, true, "publication-failed");
      }
      const original = candidate.attempt.nativeOwnership;
      return yield* settle((interrupted) =>
        adoptNativeMobileSuccessor({
          ...adopted,
          signals: { detach: AbortSignal.any([signals.detach, interrupted]), stop: signals.stop },
          serveUpstream: () => Promise.reject(Error("Mobile consent is off; nothing to serve.")),
          recordExit: (exit, signal) =>
            recordNativeMobileSuccessorExit(authority, client, pending, original, exit, signal),
          use: () => Promise.reject(Error("Mobile consent is off; readiness is refused.")),
        }),
      );
    }),
  );
});

export type NativeMobileSuccessorServices = Effect.Services<
  ReturnType<typeof runNativeMobileSuccessor>
>;
