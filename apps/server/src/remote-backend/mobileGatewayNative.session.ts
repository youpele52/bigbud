import { randomBytes } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import {
  MobileGatewayConfiguration,
  validateMobileGatewayConfiguration,
} from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import {
  acquireManagedNativeLeaseChannel,
  managedNativeLeaseChannel,
} from "./localSupervisorService.leaseChannel.ts";
import { acquireMobileGatewayActivationAuthority } from "./mobileGatewayActivation.authority.ts";
import { nativeMobileActivationAssets } from "./mobileGatewayActivation.native.assets.ts";
import {
  nativeMobileActivationLease,
  nativeMobileActivationPorts,
} from "./mobileGatewayActivation.native.ts";
import {
  MobileActivationWorkerRepair,
  runMobileActivationWorker,
} from "./mobileGatewayActivation.worker.ts";
import { validateMobileGatewayListener } from "./mobileGatewayListener.prefix.ts";
import { serveSealedMobileUpstream } from "./mobileGatewayListener.upstream.ts";
import { makeNativeMobileGatewayLaunchPreparation } from "./mobileGatewayNative.prepare.ts";
import { nativeMobileGatewayProcessPort } from "./mobileGatewayOwner.port.ts";

export class NativeMobileGatewaySessionError extends Data.TaggedError(
  "NativeMobileGatewaySessionError",
)<{
  readonly message: string;
  /** Original native ownership is uncertain; preserve intent, pin and assets for repair. */
  readonly repairRequired: boolean;
  readonly cause?: unknown;
}> {}
const failure = (cause?: unknown) =>
  cause instanceof NativeMobileGatewaySessionError
    ? cause
    : new NativeMobileGatewaySessionError({
        message: "The native mobile gateway session could not complete.",
        repairRequired: cause instanceof MobileActivationWorkerRepair,
        cause,
      });

/** Caller intents for one session. Stop wins over detach when both are requested. */
export interface NativeMobileGatewaySessionSignals {
  /** Hand native ownership to a successor: the original child keeps running. */
  readonly detach: AbortSignal;
  /** Stop the original child and record its confirmed exit. */
  readonly stop: AbortSignal;
}

/**
 * Settle the worker even when this fiber is interrupted: interruption becomes a detach request
 * (successor recovery can adopt the child) and the fiber waits, so the upstream/channel scope can
 * never close underneath accepted native work.
 */
const settledWorker = <A>(run: (interrupted: AbortSignal) => Promise<A>) =>
  Effect.callback<A, NativeMobileGatewaySessionError>((resume, interrupted) => {
    const work = Promise.resolve().then(() => run(interrupted));
    work.then(
      (value) => resume(Effect.succeed(value)),
      (cause: unknown) => resume(Effect.fail(failure(cause))),
    );
    return Effect.promise(() =>
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
  });

/**
 * One fresh original native gateway activation, default-off (no production caller yet).
 *
 * Acquisition: activation authority → shared listener validation → consent-off subscription →
 * managed lease channel → sealed upstream (fresh credential) → native preparation (with the
 * sealed upstream's configuration) → activation worker, whose `use` admits through the shared
 * gateway owner over the native process port.
 *
 * Release (reverse scope order): the worker settles first (owner admission closed, then stop with
 * confirmed exit record, or detach) → upstream HTTP, then socket → channel → consent subscription.
 * The activation authority holds no resource.
 */
export const runNativeMobileGatewaySession = Effect.fn("runNativeMobileGatewaySession")(function* (
  proof: VerifiedMobilePublication,
  input: MobileGatewayConfiguration,
  signals: NativeMobileGatewaySessionSignals,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const configuration = yield* Effect.try({
        try: () => {
          const fixed = Object.freeze(
            Schema.decodeUnknownSync(MobileGatewayConfiguration)(input, {
              onExcessProperty: "error",
            }),
          );
          validateMobileGatewayConfiguration(fixed);
          if (signals.detach.aborted || signals.stop.aborted)
            throw Error("Native session was retired before acquisition.");
          return fixed;
        },
        catch: failure,
      });
      const authority = yield* acquireMobileGatewayActivationAuthority;
      const listener = yield* validateMobileGatewayListener(proof);
      const assertAllowed = async () => {
        await authority.assertAuthority();
        await listener.assertAllowed();
      };
      // Consent-off is a stop request: before Start it cancels unlaunched; after, it records exit.
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
      const channel = yield* acquireManagedNativeLeaseChannel();
      // Released last among session resources after the worker: HTTP closes, then the socket.
      const selectedConfig = yield* serveSealedMobileUpstream(
        listener.config,
        listener.owner,
        randomBytes(32).toString("hex"),
        assertAllowed,
      );
      const preparation = yield* makeNativeMobileGatewayLaunchPreparation(proof, configuration, {
        channel,
      }).pipe(Effect.provideService(ServerConfig, selectedConfig));
      const client = managedNativeLeaseChannel(channel).client;
      const runOwner = Effect.runPromiseWith(
        yield* Effect.services<
          RemoteAgentRuntimeOwners | RemoteBackendIdentityService | ServerSettingsService
        >(),
      );
      return yield* settledWorker((interrupted) =>
        runMobileActivationWorker({
          ...nativeMobileActivationPorts(client, preparation, nativeMobileActivationAssets(proof)),
          detach: AbortSignal.any([signals.detach, interrupted]),
          stop: AbortSignal.any([signals.stop, consentOff.signal]),
          // Publication lifetime is held by the process port; reads/CAS revalidate it per step.
          withSelection: async (signal, use) => {
            signal.throwIfAborted();
            await assertAllowed();
            signal.throwIfAborted();
            return use(configuration);
          },
          use: (lease, signal) => {
            // Resolve before the worker's stop/detach: both retire the held lease first.
            const held = nativeMobileActivationLease(lease);
            const port = nativeMobileGatewayProcessPort(lease, signal);
            const selected = Object.freeze({
              nonce: held.client.binding(held.pending).nonce,
              ...configuration,
            });
            return runOwner(
              listener.gateway
                .runWith(proof, selected, port)
                .pipe(Effect.provideService(ServerConfig, selectedConfig)),
            );
          },
        }),
      );
    }),
  ).pipe(Effect.mapError(failure));
});

export type NativeMobileGatewaySessionServices = Effect.Services<
  ReturnType<typeof runNativeMobileGatewaySession>
>;
