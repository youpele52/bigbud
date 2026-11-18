import { cancelUnlaunchedMobileGatewayAttempt } from "./mobileGatewayLifecycle.cancel.ts";
import {
  captureMobileGatewayChild,
  type CapturedMobileGatewayChild,
} from "./mobileGatewayLifecycle.child.ts";
import { completeObservedMobileGatewayExit } from "./mobileGatewayLifecycle.exit.ts";
import type { ChildProcess } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BackendInstance } from "../startup/backendInstance.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import type { VerifiedMobilePublication } from "./mobileOptionalPublication.ts";
import {
  withMobilePublicationOwner,
  withMobilePublicationTeardown,
} from "./mobileGatewayLifecycle.publication.ts";
import { mobileGatewayAdmissionContext } from "./mobileGatewayLifecycle.context.ts";
import {
  MobileGatewayConfiguration,
  validateMobileGatewayConfiguration,
} from "./mobileGatewayLifecycle.schema.ts";
import {
  reserveMobileGatewayAttempt,
  advanceMobileGatewayAttempt,
  type MobileGatewayAdmissionContext,
} from "./mobileGatewayLifecycle.transitions.ts";

declare const permitBrand: unique symbol, childBrand: unique symbol;
export interface MobileGatewayLaunchPermit {
  readonly [permitBrand]: true;
}
export interface MobileGatewayOwnedChild {
  readonly [childBrand]: true;
}
type OwnedPublication = Parameters<Parameters<typeof withMobilePublicationOwner>[1]>[0];
interface Permit {
  readonly nonce: string;
  readonly context: MobileGatewayAdmissionContext;
  consumed: boolean;
  cancelled: boolean;
  callbackInvoked: boolean;
  reservationOwned: boolean;
  admitted: boolean;
  cancellation?: Promise<void>;
}
interface Child {
  readonly permit: Permit;
  readonly captured: CapturedMobileGatewayChild;
  completion?: Promise<void>;
}

/** No child is started by construction. Every launch callback needs a fresh original one-use permit. */
export function makeMobileGatewayLifecycle(proof: VerifiedMobilePublication, input: unknown) {
  return Effect.gen(function* () {
    const owner = yield* BackendInstance;
    const owners = yield* RemoteAgentRuntimeOwners;
    const configuration = Object.freeze(
      Schema.decodeUnknownSync(MobileGatewayConfiguration)(input, { onExcessProperty: "error" }),
    );
    validateMobileGatewayConfiguration(configuration);
    const permits = new WeakMap<MobileGatewayLaunchPermit, Permit>();
    const originalPermits = new Map<string, MobileGatewayLaunchPermit>();
    const children = new WeakMap<MobileGatewayOwnedChild, Child>();
    const childTokens = new WeakMap<ChildProcess, MobileGatewayOwnedChild>();
    const pending = new Map<string, Promise<MobileGatewayLaunchPermit | null>>();
    const context = (publication: OwnedPublication, signal: AbortSignal) =>
      mobileGatewayAdmissionContext(owner, owners, configuration, publication, signal);
    const reserve = (
      nonce: string,
      external?: AbortSignal,
    ): Promise<MobileGatewayLaunchPermit | null> => {
      const joined = pending.get(nonce);
      if (joined) return joined;
      const job = withMobilePublicationOwner(
        proof,
        async (publication, signal) => {
          const current = await context(publication, signal);
          const store = publication.authority.registry(signal);
          const before = await store.read();
          if (before.schemaVersion !== 3) throw new Error("Gateway requires publication v3 CAS.");
          const prior = before.mobile.gatewayLifecycle?.attempts.some((a) => a.nonce === nonce);
          if (!prior && originalPermits.size >= 32)
            throw new Error("Original gateway permit capacity is full.");
          const token = Object.freeze({}) as MobileGatewayLaunchPermit;
          const record: Permit = {
            nonce,
            context: current,
            consumed: false,
            cancelled: false,
            callbackInvoked: false,
            reservationOwned: false,
            admitted: false,
          };
          let created = false;
          const result = await store.update((state) => {
            created =
              state.schemaVersion === 3 &&
              !state.mobile.gatewayLifecycle?.attempts.some((a) => a.nonce === nonce);
            record.reservationOwned = created;
            if (created) {
              permits.set(token, record);
              originalPermits.set(nonce, token);
            }
            return reserveMobileGatewayAttempt(state, current, nonce);
          });
          if (result.schemaVersion !== 3 || result.mobile.gatewayLifecycle?.repairRequired)
            throw new Error("Gateway durable budget/clock requires explicit owner repair.");
          if (!created) return null;
          const recorded = result.mobile.gatewayLifecycle?.attempts.find((a) => a.nonce === nonce);
          if (!recorded || recorded.phase !== "reserved") return null;
          // A lost ACK can reconcile this call's reservation; later calls only see a spent nonce.
          record.admitted = true;
          return token;
        },
        external,
      );
      pending.set(nonce, job);
      void job.then(
        () => pending.delete(nonce),
        () => pending.delete(nonce),
      );
      return job;
    };
    const attempt = (
      token: MobileGatewayLaunchPermit,
      launch: (
        description: Readonly<{
          gatewayPath: string;
          assetsArchivePath: string;
          configuration: typeof configuration;
        }>,
      ) => ChildProcess,
      external?: AbortSignal,
    ): Promise<MobileGatewayOwnedChild> => {
      const permit = permits.get(token);
      if (!permit || !permit.admitted || permit.consumed || permit.cancelled)
        return Promise.reject(new Error("Original unspent gateway launch permit required."));
      permit.consumed = true; // Synchronous, before any await or user callback.
      return withMobilePublicationOwner(
        proof,
        async (publication, signal) => {
          const current = await context(publication, signal);
          if (
            JSON.stringify({ ...current, now: 0 }) !== JSON.stringify({ ...permit.context, now: 0 })
          )
            throw new Error("Gateway admission changed before launch.");
          const result = await publication.authority
            .registry(signal)
            .update((state) =>
              advanceMobileGatewayAttempt(state, current, permit.nonce, "attempted"),
            );
          if (result.schemaVersion !== 3 || result.mobile.gatewayLifecycle?.repairRequired)
            throw new Error("Gateway durable clock requires owner repair.");
          const final = await context(publication, signal);
          if (JSON.stringify(final.binding) !== JSON.stringify(current.binding))
            throw new Error("Gateway epoch changed before launch.");
          const launchGuard = await publication.authority
            .registry(signal)
            .update((state) =>
              advanceMobileGatewayAttempt(state, final, permit.nonce, "attempted"),
            );
          if (
            launchGuard.schemaVersion !== 3 ||
            launchGuard.mobile.gatewayLifecycle?.repairRequired
          )
            throw new Error(
              "Gateway consent/clock changed before launch; preserve attempted fence.",
            );
          signal.throwIfAborted();
          if (permit.cancelled) throw new Error("Gateway permit was cancelled before callback.");
          permit.callbackInvoked = true;
          const child = launch(
            Object.freeze({
              gatewayPath: publication.paths.gatewayPath,
              assetsArchivePath: publication.paths.assetsArchivePath,
              configuration,
            }),
          );
          const captured = captureMobileGatewayChild(child, owner.pid);
          const owned: Child = { permit, captured };
          // Original handle capability exists before /proc/start probing or any identity CAS.
          const ownedToken = Object.freeze({}) as MobileGatewayOwnedChild;
          children.set(ownedToken, owned);
          childTokens.set(child, ownedToken);
          const identity = captured.probeIdentity();
          if (!identity)
            throw new Error(
              "Gateway child identity is uncertain; preserve attempted fence until original completion.",
            );
          const childState = await publication.authority
            .registry(signal)
            .update((state) =>
              advanceMobileGatewayAttempt(
                state,
                { ...final, now: Date.now() },
                permit.nonce,
                "child-owned",
                identity,
              ),
            );
          if (childState.schemaVersion !== 3 || childState.mobile.gatewayLifecycle?.repairRequired)
            throw new Error("Gateway clock changed after launch; preserve exact child and fence.");
          return ownedToken;
        },
        external,
      );
    };
    const recordObservedExit = (token: MobileGatewayOwnedChild): Promise<void> => {
      const child = children.get(token);
      const evidence = child?.captured.observe();
      if (!child || !evidence)
        return Promise.reject(
          new Error("Only the original observed child exit can release its attempt."),
        );
      if (child.completion) return child.completion;
      let completion: Promise<void>;
      try {
        completion = withMobilePublicationTeardown(proof, async (authority, signal) => {
          if (
            owner.nonce !== authority.owner.nonce ||
            owner.stateDir !== authority.owner.stateDir ||
            owner.lockPath !== authority.owner.lockPath ||
            owner.pid !== authority.owner.pid ||
            owner.startedAt !== authority.owner.startedAt ||
            JSON.stringify(child.permit.context.controller) !== JSON.stringify(authority.controller)
          )
            throw new Error("Original held gateway controller required for teardown.");
          await owner.assertHeld();
          await authority.registry(signal).update((state) =>
            completeObservedMobileGatewayExit(
              state,
              {
                ...child.permit.context,
                owner: authority.pin,
                controller: authority.controller,
                now: Date.now(),
              },
              child.permit.nonce,
              child.captured.identity,
              evidence,
            ),
          );
        });
      } catch (cause) {
        return Promise.reject(cause);
      }
      child.completion = completion;
      void completion.catch(() => {
        delete child.completion;
      });
      return completion;
    };
    const originalChildToken = (child: ChildProcess): MobileGatewayOwnedChild => {
      const token = childTokens.get(child);
      if (!token) throw new Error("Original child handle from this gateway attempt required.");
      return token;
    };
    const originalUnlaunchedPermit = (nonce: string): MobileGatewayLaunchPermit => {
      const token = originalPermits.get(nonce);
      if (!token || !permits.get(token)?.reservationOwned)
        throw new Error("Original owned gateway reservation unavailable.");
      return token;
    };
    const cancelUnlaunched = (token: MobileGatewayLaunchPermit): Promise<void> => {
      const permit = permits.get(token);
      if (!permit || !permit.reservationOwned || permit.callbackInvoked)
        return Promise.reject(new Error("Original never-invoked gateway permit required."));
      permit.cancelled = true;
      permit.consumed = true; // Synchronous fence immediately before any callback can run.
      if (permit.cancellation) return permit.cancellation;
      const completion = withMobilePublicationTeardown(proof, async (authority, signal) => {
        if (JSON.stringify(permit.context.controller) !== JSON.stringify(authority.controller))
          throw new Error("Original gateway cancellation controller required.");
        await authority
          .registry(signal)
          .update((state) =>
            cancelUnlaunchedMobileGatewayAttempt(
              state,
              { ...permit.context, owner: authority.pin, now: Date.now() },
              permit.nonce,
            ),
          );
      });
      permit.cancellation = completion;
      void completion.catch(() => {
        delete permit.cancellation;
      });
      return completion;
    };
    return Object.freeze({
      reserve,
      attempt,
      recordObservedExit,
      originalChildToken,
      originalUnlaunchedPermit,
      cancelUnlaunched,
    });
  });
}
