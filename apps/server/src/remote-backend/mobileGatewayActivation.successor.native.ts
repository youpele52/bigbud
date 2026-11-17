import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { MOBILE_GATEWAY_CREDENTIAL_ENV } from "@bigbud/shared/mobileGatewaySupervisor.config";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig, type ServerConfigShape } from "../startup/config.ts";
import {
  assertOriginalNativeServiceLeaseClient,
  type AttachingNativeLease,
  type ConfirmedNativeLeaseExit,
  type NativeServiceLeaseClient,
  type PendingOriginalNativeLease,
  type VerifiedNativeLease,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import type {
  MobileSuccessorNativePort,
  MobileSuccessorUpstream,
} from "./mobileGatewayActivation.successor.ts";
import { serveSealedMobileUpstream } from "./mobileGatewayListener.upstream.ts";

/** Exactly one visible-ASCII upstream credential from the private native bootstrap. */
export function mobileGatewayBootstrapCredential(
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): string {
  const matches = environment.filter((entry) => entry.name === MOBILE_GATEWAY_CREDENTIAL_ENV);
  const value = matches[0]?.value;
  if (matches.length !== 1 || !value || !/^[\x21-\x7e]{32,256}$/.test(value))
    throw Error("Original gateway bootstrap credential is unavailable.");
  return value;
}

/** The actual authenticated owner client and this attempt's retained original intent only. */
export function nativeMobileSuccessorPort(
  client: NativeServiceLeaseClient,
  pending: PendingOriginalNativeLease,
): MobileSuccessorNativePort<AttachingNativeLease, VerifiedNativeLease, ConfirmedNativeLeaseExit> {
  assertOriginalNativeServiceLeaseClient(client);
  return Object.freeze({
    resume: (signal: AbortSignal) => client.resume(pending, signal),
    attach: (attaching: AttachingNativeLease, signal: AbortSignal) =>
      client.attach(attaching, signal),
    credential: (attaching: AttachingNativeLease) =>
      client.withBootstrap(attaching, mobileGatewayBootstrapCredential),
    reconcile: async (signal: AbortSignal) => {
      const status = await client.reconcile(pending, signal);
      return status.state === "exited"
        ? { kind: "exited" as const, exit: status.exit }
        : { kind: "unsettled" as const };
    },
    stop: async (signal: AbortSignal) => {
      const result = await client.stopOriginal(pending, signal);
      if (result.state !== "exited") throw Error("Original native exit is unconfirmed.");
      return result.exit;
    },
  });
}

/** A served, sealed successor upstream and the configuration its routes run with. */
export interface NativeMobileSuccessorUpstream extends MobileSuccessorUpstream {
  readonly config: ServerConfigShape;
}
type UpstreamServices = Exclude<
  Effect.Services<ReturnType<typeof serveSealedMobileUpstream>>,
  Scope.Scope
>;
/**
 * Successor upstream port over the same sealed-socket helper as a fresh activation. Each call
 * owns its own scope; release closes HTTP first, then the socket. The caller holds the original
 * publication scope and supplies the same consent/ownership assertion as the listener.
 */
export const makeMobileSuccessorUpstream = Effect.fn("makeMobileSuccessorUpstream")(function* (
  assertAllowed: () => Promise<void>,
) {
  const config = yield* ServerConfig,
    owner = yield* BackendInstance;
  const services = yield* Effect.services<UpstreamServices>();
  return async (
    credential: string,
    signal: AbortSignal,
  ): Promise<NativeMobileSuccessorUpstream> => {
    signal.throwIfAborted();
    const run = Effect.runPromiseWith(services);
    const scope = await run(Scope.make());
    const close = () => run(Scope.close(scope, Exit.void));
    let selected: ServerConfigShape;
    try {
      selected = await run(
        serveSealedMobileUpstream(config, owner, credential, assertAllowed).pipe(
          Scope.provide(scope),
        ),
        { signal },
      );
    } catch (cause) {
      await close();
      throw cause;
    }
    let released: Promise<void> | undefined;
    // `config` is the sealed upstream's selected configuration, as for a fresh session.
    return Object.freeze({ config: selected, release: () => (released ??= close()) });
  };
});
