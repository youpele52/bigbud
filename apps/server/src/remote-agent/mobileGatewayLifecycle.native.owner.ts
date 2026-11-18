import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BackendInstance } from "../startup/backendInstance.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import type { VerifiedMobilePublication } from "./mobileOptionalPublication.ts";
import {
  assertOriginalNativeServiceLeaseClient,
  type NativeServiceLeaseClient,
  type PendingOriginalNativeLease,
} from "./remoteAgentServiceLeaseClient.ts";
import {
  withOriginalMobileGatewayAssets,
  armMobileGatewayAssetsTransfer,
  type OwnedMobileGatewayAssets,
} from "../remote-backend/mobileGatewayProcess.assets.ts";
import {
  mobileAssetsReceiptFileState,
  verifyMobileAssetsReceiptFile,
} from "../remote-backend/mobileGatewayAssets.receipt.files.ts";
import { withMobilePublicationOwner } from "./mobileGatewayLifecycle.publication.ts";
import { mobileGatewayAdmissionContext } from "./mobileGatewayLifecycle.context.ts";
import {
  MobileGatewayConfiguration,
  validateMobileGatewayConfiguration,
} from "./mobileGatewayLifecycle.schema.ts";
import {
  MobileNativeGatewayOwnership,
  type MobileNativeGatewayOwnership as Original,
} from "./mobileGatewayLifecycle.native.schema.ts";
import { reserveNativeMobileGatewayAttempt } from "./mobileGatewayLifecycle.native.transitions.ts";
import {
  advanceMobileGatewayAttempt,
  type MobileGatewayAdmissionContext,
} from "./mobileGatewayLifecycle.transitions.ts";

declare const intentBrand: unique symbol;
export interface OriginalNativeMobileGatewayIntent {
  readonly [intentBrand]: true;
}
interface Intent {
  readonly assets: OwnedMobileGatewayAssets;
  readonly client: NativeServiceLeaseClient;
  readonly pending: PendingOriginalNativeLease;
  readonly original: Original;
  context?: MobileGatewayAdmissionContext;
  admitted: boolean;
  consumed: boolean;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Account-owned CAS journal only; construction never connects, starts, enables or publishes status. */
export const makeNativeMobileGatewayOwnership = Effect.fn("makeNativeMobileGatewayOwnership")(
  function* (proof: VerifiedMobilePublication, input: unknown) {
    const owner = yield* BackendInstance,
      owners = yield* RemoteAgentRuntimeOwners;
    const configuration = Object.freeze(
      Schema.decodeUnknownSync(MobileGatewayConfiguration)(input, { onExcessProperty: "error" }),
    );
    validateMobileGatewayConfiguration(configuration);
    const intents = new WeakMap<OriginalNativeMobileGatewayIntent, Intent>();
    const pendingJobs = new Map<
      PendingOriginalNativeLease,
      {
        readonly intent: Intent;
        readonly promise: Promise<OriginalNativeMobileGatewayIntent | null>;
      }
    >();
    function reserve(
      assets: OwnedMobileGatewayAssets,
      client: NativeServiceLeaseClient,
      pending: PendingOriginalNativeLease,
      external?: AbortSignal,
    ): Promise<OriginalNativeMobileGatewayIntent | null> {
      try {
        assertOriginalNativeServiceLeaseClient(client);
        client.assertActivationCapability(); // Additional fence; app preflight must precede consent/download too.
        const joined = pendingJobs.get(pending);
        if (joined) {
          if (joined.intent.assets !== assets || joined.intent.client !== client)
            throw Error("Original native pending belongs to another assets/client operation.");
          return joined.promise;
        }
        if (pendingJobs.size >= 32)
          throw Error("Native original intent capacity exhausted; preserve history.");
        const original = Schema.decodeUnknownSync(MobileNativeGatewayOwnership)(
          client.original(pending),
          { onExcessProperty: "error" },
        );
        // Restrictive transfer is armed BEFORE reservation can be invoked or its ACK lost.
        armMobileGatewayAssetsTransfer(assets);
        const token = Object.freeze({}) as OriginalNativeMobileGatewayIntent;
        const record: Intent = {
          assets,
          client,
          pending,
          original,
          admitted: false,
          consumed: false,
        };
        intents.set(token, record);
        const promise = withOriginalMobileGatewayAssets(
          proof,
          assets,
          async (data, publication, signal) => {
            const receipt = mobileAssetsReceiptFileState(assets);
            if (
              data.nonce !== original.binding.nonce ||
              !receipt ||
              !equal(receipt.reference, original.assetsReference)
            )
              throw Error(
                "Original receipt/preparation nonce does not match actual native Pending.",
              );
            await verifyMobileAssetsReceiptFile(receipt, `${data.path}.receipt.json`, signal);
            const context = await mobileGatewayAdmissionContext(
              owner,
              owners,
              configuration,
              publication,
              signal,
            );
            record.context = context;
            let created = false;
            const state = await publication.authority.registry(signal).update((before) => {
              created =
                before.schemaVersion === 3 &&
                !before.mobile.gatewayLifecycle?.attempts.some(
                  (a) => a.nonce === original.binding.nonce,
                );
              return reserveNativeMobileGatewayAttempt(before, context, original);
            });
            if (state.schemaVersion !== 3 || state.mobile.gatewayLifecycle?.repairRequired)
              throw Error("Native original budget/clock requires admitted owner repair.");
            const row = state.mobile.gatewayLifecycle?.attempts.find(
              (a) => a.nonce === original.binding.nonce,
            );
            if (!created || row?.phase !== "reserved" || !equal(row.nativeOwnership, original))
              return null;
            const final = await mobileGatewayAdmissionContext(
              owner,
              owners,
              configuration,
              publication,
              signal,
            );
            if (!equal({ ...context, now: 0 }, { ...final, now: 0 }))
              throw Error(
                "Native original admission changed while reserving; preserve armed assets/pin.",
              );
            record.admitted = true;
            return token;
          },
          external,
        );
        pendingJobs.set(pending, { intent: record, promise });
        return promise;
      } catch (cause) {
        return Promise.reject(cause);
      }
    }
    function markInvoked(
      token: OriginalNativeMobileGatewayIntent,
      external?: AbortSignal,
    ): Promise<void> {
      const record = intents.get(token);
      if (!record || !record.admitted || record.consumed || !record.context)
        return Promise.reject(Error("Original unspent native CAS intent required."));
      record.consumed = true;
      const originalContext = record.context;
      return withMobilePublicationOwner(
        proof,
        async (publication, signal) => {
          const current = await mobileGatewayAdmissionContext(
            owner,
            owners,
            configuration,
            publication,
            signal,
          );
          if (!equal({ ...current, now: 0 }, { ...originalContext, now: 0 }))
            throw Error("Original native launch admission changed.");
          const store = publication.authority.registry(signal);
          const state = await store.update((before) => {
            const row =
              before.schemaVersion === 3 &&
              before.mobile.gatewayLifecycle?.attempts.find(
                (a) => a.nonce === record.original.binding.nonce,
              );
            if (!row || !equal(row.nativeOwnership, record.original))
              throw Error("Native original intent changed.");
            return advanceMobileGatewayAttempt(before, current, row.nonce, "attempted");
          });
          if (state.schemaVersion !== 3 || state.mobile.gatewayLifecycle?.repairRequired)
            throw Error("Native launch clock requires explicit repair.");
          const final = await mobileGatewayAdmissionContext(
            owner,
            owners,
            configuration,
            publication,
            signal,
          );
          if (!equal(final.binding, current.binding))
            throw Error("Canonical native epoch changed before Start.");
          const guard = await store.update((before) =>
            advanceMobileGatewayAttempt(before, final, record.original.binding.nonce, "attempted"),
          );
          if (guard.schemaVersion !== 3 || guard.mobile.gatewayLifecycle?.repairRequired)
            throw Error("Native consent/clock changed before Start; preserve exact attempt fence.");
          signal.throwIfAborted();
        },
        external,
      );
    }
    return Object.freeze({ reserve, markInvoked });
  },
);
