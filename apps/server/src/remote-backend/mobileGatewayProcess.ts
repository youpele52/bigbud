import { MobilePublicationWorkBusy } from "../remote-agent/mobileOptionalPublication.work.ts";
import { Effect } from "effect";
import type { ChildProcess } from "node:child_process";
import { MobileGatewaySupervisor } from "@bigbud/shared/mobileGatewaySupervisor";
import {
  mobileGatewayCommand,
  MOBILE_GATEWAY_POLICY,
} from "@bigbud/shared/mobileGatewaySupervisor.config";
import {
  REMOTE_BACKEND_HANDSHAKE_REVISION,
  REMOTE_BACKEND_MOBILE_RPC_REVISION,
} from "@bigbud/contracts/server/remoteBackendHandshake";
import type { RemoteMobileAdmissionStamp } from "./mobileGatewayStatus.ts";
import { version } from "../../package.json" with { type: "json" };
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { makeMobileGatewayLifecycle } from "../remote-agent/mobileGatewayLifecycle.ts";
import type { MobileGatewayLaunchPermit } from "../remote-agent/mobileGatewayLifecycle.ts";
import {
  withMobilePublicationLifetime,
  withMobilePublicationTeardown,
} from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import {
  revalidateMobileOptionalPublication,
  type VerifiedMobilePublication,
} from "../remote-agent/mobileOptionalPublication.ts";
import {
  prepareMobileGatewayAssets,
  markMobileGatewayAssetsLaunched,
  mobileGatewayAssetsPath,
  removeMobileGatewayAssets,
  type OwnedMobileGatewayAssets,
} from "./mobileGatewayProcess.assets.ts";
import {
  captureSealedMobileGatewaySocket,
  mobileGatewayProcessConfiguration,
  type MobileGatewayProcessInput,
} from "./mobileGatewayProcess.config.ts";
import { mobileGatewayOwnedSpawn, awaitMobileGatewayClose } from "./mobileGatewayProcess.spawn.ts";
import {
  MobileGatewayProcessError,
  settledMobileGatewayProcess,
} from "./mobileGatewayProcess.lifetime.ts";
import { mobileGatewayProcessAdmission } from "./mobileGatewayProcess.admission.ts";

declare const processBrand: unique symbol;
export interface VerifiedMobileGatewayProcess {
  readonly [processBrand]: true;
}
interface ProcessProof {
  readonly read: (signal?: AbortSignal) => Promise<RemoteMobileAdmissionStamp>;
}
const processes = new WeakMap<VerifiedMobileGatewayProcess, ProcessProof>();
/** Fresh durable consent, never a JSON-ready setter; caller cancellation cannot stop another reader. */
export function readVerifiedMobileGatewayProcess(
  token: VerifiedMobileGatewayProcess,
  signal?: AbortSignal,
): Promise<RemoteMobileAdmissionStamp> {
  const proof = processes.get(token);
  return proof
    ? proof.read(signal)
    : Promise.reject(Error("Original live verified gateway process required."));
}
export function isMobileGatewayProcessRepairRequired(cause: unknown): boolean {
  return cause instanceof MobileGatewayProcessError && cause.repairRequired;
}

/** Private process only. Global admission and actual external-route confirmation remain with its owner. */
export function withMobileGatewayProcess<A>(
  proof: VerifiedMobilePublication,
  input: MobileGatewayProcessInput,
  callback: (token: VerifiedMobileGatewayProcess, signal: AbortSignal) => Promise<A>,
) {
  return Effect.gen(function* () {
    const owner = yield* BackendInstance,
      config = yield* ServerConfig,
      identity = yield* RemoteBackendIdentityService,
      owners = yield* RemoteAgentRuntimeOwners;
    const selected = yield* Effect.try({
      try: () => mobileGatewayProcessConfiguration(owner, config, input),
      catch: (cause) =>
        new MobileGatewayProcessError({
          message: "Private mobile process configuration unavailable.",
          repairRequired: false,
          cause,
        }),
    });
    const api = yield* makeMobileGatewayLifecycle(proof, {
      externalOrigin: selected.selected.externalOrigin,
      port: selected.selected.port,
    });
    const expected = {
      handshakeRevision: REMOTE_BACKEND_HANDSHAKE_REVISION,
      authority: identity.authority,
      installationFingerprint: identity.installationFingerprint,
      backendVersion: version,
      mobileRpcRevision: REMOTE_BACKEND_MOBILE_RPC_REVISION,
      mobileCapable: false,
    };
    return yield* settledMobileGatewayProcess((external) =>
      withMobilePublicationLifetime(
        proof,
        async (lifetime) => {
          const controller = new AbortController(),
            signal = AbortSignal.any([external, lifetime, controller.signal]);
          let assets: OwnedMobileGatewayAssets | undefined,
            permit: MobileGatewayLaunchPermit | null | undefined,
            supervisor: MobileGatewaySupervisor | undefined,
            child: ChildProcess | undefined;
          let closed: Promise<void> | undefined,
            start: Promise<{ ok: true } | { ok: false; cause: unknown }> | undefined;
          let admission: Awaited<ReturnType<typeof mobileGatewayProcessAdmission>> | undefined,
            token: VerifiedMobileGatewayProcess | undefined;
          let callbackCompletion: Promise<A> | undefined,
            watch: ReturnType<typeof setInterval> | undefined,
            checking: Promise<void> | undefined;
          let outcome:
            | { readonly ok: true; readonly value: A }
            | { readonly ok: false; readonly cause: unknown } = { ok: false, cause: undefined };
          let cleanupFailure: unknown;
          try {
            signal.throwIfAborted();
            assets = await prepareMobileGatewayAssets(proof, selected.selected.nonce, signal);
            signal.throwIfAborted();
            const assertSocket = captureSealedMobileGatewaySocket(selected.upstream.path);
            const paths = await revalidateMobileOptionalPublication(proof, signal);
            mobileGatewayCommand({
              binary: paths.gatewayPath,
              port: selected.selected.port,
              externalOrigin: selected.selected.externalOrigin,
              assetsDir: mobileGatewayAssetsPath(assets),
              upstream: selected.upstream,
              credential: selected.credential,
            });
            permit = await api.reserve(selected.selected.nonce, signal);
            if (!permit)
              throw Error("Gateway nonce was already spent; a fresh admission is required.");
            const runtimeAssets = assets;
            await api.attempt(
              permit,
              (description) => {
                assertSocket();
                markMobileGatewayAssetsLaunched(runtimeAssets);
                supervisor = new MobileGatewaySupervisor(
                  {
                    binary: description.gatewayPath,
                    port: selected.selected.port,
                    externalOrigin: selected.selected.externalOrigin,
                    assetsDir: mobileGatewayAssetsPath(runtimeAssets),
                    upstream: selected.upstream,
                    credential: selected.credential,
                  },
                  {
                    autoRestart: false,
                    allowed: () => !signal.aborted,
                    spawn: mobileGatewayOwnedSpawn((created) => {
                      child = created;
                      closed = new Promise((resolve) => created.once("close", () => resolve()));
                      created.once("close", () =>
                        controller.abort(Error("Owned mobile gateway child closed.")),
                      );
                    }),
                  },
                );
                start = supervisor
                  .start(() => !signal.aborted)
                  .then(
                    () => ({ ok: true as const }),
                    (cause) => ({ ok: false as const, cause }),
                  );
                if (!child) throw Error("Gateway launch returned no original child handle.");
                return child;
              },
              signal,
            );
            if (!supervisor || !child || !start)
              throw Error("Original gateway launch did not complete.");
            const ready = await start;
            if (!ready.ok) throw ready.cause;
            signal.throwIfAborted();
            admission = await mobileGatewayProcessAdmission({
              proof,
              nonce: selected.selected.nonce,
              port: selected.selected.port,
              externalOrigin: selected.selected.externalOrigin,
              expected,
              owners,
              child,
              supervisor,
              signal,
              assertSocket,
              assets,
            });
            await admission.full();
            signal.throwIfAborted();
            token = Object.freeze({}) as VerifiedMobileGatewayProcess;
            processes.set(token, { read: admission.read });
            const guarded = admission;
            watch = setInterval(() => {
              checking ??= guarded
                .full()
                .catch((cause) => {
                  if (!(cause instanceof MobilePublicationWorkBusy)) controller.abort(cause);
                })
                .finally(() => {
                  checking = undefined;
                });
            }, 1000);
            watch.unref();
            const original = token;
            callbackCompletion = Promise.resolve().then(() => {
              signal.throwIfAborted();
              return callback(original, signal);
            });
            let cancel!: () => void;
            const aborted = new Promise<never>((_resolve, reject) => {
              cancel = () => reject(signal.reason);
              signal.addEventListener("abort", cancel, { once: true });
              if (signal.aborted) cancel();
            });
            try {
              outcome = { ok: true, value: await Promise.race([callbackCompletion, aborted]) };
            } finally {
              signal.removeEventListener("abort", cancel);
            }
          } catch (cause) {
            outcome = { ok: false, cause };
          } finally {
            if (token) processes.delete(token);
            controller.abort();
            if (watch) clearInterval(watch);
            await checking;
            await admission?.close();
            try {
              if (supervisor) await supervisor.stop().catch(() => {});
              if (child) {
                if (
                  !closed ||
                  !(await awaitMobileGatewayClose(closed, MOBILE_GATEWAY_POLICY.shutdownMs))
                )
                  cleanupFailure = Error(
                    "Gateway child exit remains unconfirmed; retain runtime/pin.",
                  );
                else await api.recordObservedExit(api.originalChildToken(child));
              } else {
                let original: MobileGatewayLaunchPermit | undefined = permit ?? undefined;
                if (!original) {
                  try {
                    original = api.originalUnlaunchedPermit(selected.selected.nonce);
                  } catch {}
                }
                if (original) await api.cancelUnlaunched(original);
              }
              if (assets && cleanupFailure === undefined)
                await removeMobileGatewayAssets(proof, assets);
            } catch (cause) {
              cleanupFailure = cause;
            }
            await start;
            await callbackCompletion?.then(
              () => {},
              () => {},
            );
          }
          if (cleanupFailure !== undefined)
            throw new MobileGatewayProcessError({
              message: "Private gateway cleanup is uncertain; preserve ownership for repair.",
              repairRequired: true,
              cause: cleanupFailure,
            });
          if (!outcome.ok) {
            const repairRequired = await withMobilePublicationTeardown(proof, async (authority) => {
              const state = await authority.registry().read();
              return (
                state.schemaVersion === 3 && state.mobile.gatewayLifecycle?.repairRequired === true
              );
            }).catch(() => true);
            throw new MobileGatewayProcessError({
              message: "Private mobile gateway stopped before operation completed.",
              repairRequired,
              cause: outcome.cause,
            });
          }
          return outcome.value;
        },
        external,
      ),
    );
  });
}
