import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { acquireMobileGatewayActivationAuthority } from "./mobileGatewayActivation.authority.ts";
import type { RemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import {
  mobileRegistryOwnerEqual,
  type MobileRegistryOwner,
} from "../remote-agent/remoteAgentInstall.mobile.schema.ts";
import { setRemoteAgentMobileConsent } from "../remote-agent/remoteAgentInstall.mobile.transitions.ts";

export interface MobileConsentState {
  readonly enabled: boolean;
  /** 0 before the first separate mobile write (v2 or missing journal). */
  readonly revision: number;
}
export class MobileConsentJournalError extends Data.TaggedError("MobileConsentJournalError")<{
  readonly code: "unavailable" | "stale" | "not-installed";
  readonly cause?: unknown;
}> {}

export function mobileConsentState(state: RemoteAgentRegistry): MobileConsentState {
  return state.schemaVersion === 3
    ? { enabled: state.mobile.consent.enabled, revision: state.mobile.consent.revision }
    : { enabled: false, revision: 0 };
}

/**
 * Owner grant (decision D-B), a CAS on the revision the owner last observed. Every real
 * transition bumps the revision through `setRemoteAgentMobileConsent` (which also cancels every
 * stage), so after revoke → enable no attempt from the earlier grant matches the current revision:
 * successor recovery can only revoke such an original, never serve it. Enabling an already enabled
 * journal is a no-op that keeps the revision, so a running original stays admitted.
 */
export function enableMobileConsentTransition(
  state: RemoteAgentRegistry,
  owner: MobileRegistryOwner,
  expectedRevision: number,
): RemoteAgentRegistry {
  if (!state.current) throw new MobileConsentJournalError({ code: "not-installed" });
  const current = mobileConsentState(state);
  if (current.revision !== expectedRevision) throw new MobileConsentJournalError({ code: "stale" });
  if (state.schemaVersion === 3 && !mobileRegistryOwnerEqual(owner, state.mobile.owner))
    throw new MobileConsentJournalError({ code: "unavailable" });
  return setRemoteAgentMobileConsent(
    state,
    { owner, expectedConsentRevision: current.revision },
    true,
  );
}

export interface RemoteMobileConsentJournalShape {
  readonly read: Effect.Effect<MobileConsentState, MobileConsentJournalError>;
  readonly enable: (
    expectedRevision: number,
  ) => Effect.Effect<MobileConsentState & { readonly changed: boolean }, MobileConsentJournalError>;
}
export class RemoteMobileConsentJournal extends ServiceMap.Service<
  RemoteMobileConsentJournal,
  RemoteMobileConsentJournalShape
>()("bigbud/remote-backend/MobileConsentJournal") {}

const asJournalError = (cause: unknown) =>
  cause instanceof MobileConsentJournalError
    ? cause
    : new MobileConsentJournalError({ code: "unavailable", cause });

/** Pure construction; each call re-proves the locked Linux backend and claimed account authority. */
export const RemoteMobileConsentJournalLive = Layer.effect(
  RemoteMobileConsentJournal,
  Effect.gen(function* () {
    const services = yield* Effect.services<
      BackendInstance | RemoteBackendIdentityService | ServerConfig
    >();
    const withRegistry = <A>(
      use: (
        authority: Effect.Success<typeof acquireMobileGatewayActivationAuthority>,
        signal: AbortSignal,
      ) => Promise<A>,
    ) =>
      acquireMobileGatewayActivationAuthority.pipe(
        Effect.flatMap((authority) => Effect.tryPromise((signal) => use(authority, signal))),
        Effect.provideServices(services),
        Effect.mapError((error) => asJournalError("cause" in error ? error.cause : error)),
      );
    return RemoteMobileConsentJournal.of({
      read: withRegistry(async (authority, signal) =>
        mobileConsentState(await authority.registry(signal).read()),
      ).pipe(Effect.withSpan("RemoteMobileConsentJournal.read")),
      enable: Effect.fn("RemoteMobileConsentJournal.enable")(function* (expectedRevision: number) {
        return yield* withRegistry(async (authority, signal) => {
          const after = mobileConsentState(
            await authority
              .registry(signal)
              .update((state) =>
                enableMobileConsentTransition(state, authority.pin, expectedRevision),
              ),
          );
          // The transition requires the expected revision, so any bump is this grant.
          return { ...after, changed: after.revision !== expectedRevision };
        });
      }),
    });
  }),
);
