import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import { compareRemoteBackendIdentity } from "@bigbud/shared/remoteBackendIdentity";
import { version } from "../../package.json" with { type: "json" };
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { resolveRemoteMobileConfiguration } from "../startup/config.remoteMobile.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { BootstrapCommandLockService } from "../ws/wsBootstrap.lock.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteMobileGatewayOwner } from "./mobileGatewayOwner.service.ts";
import { MobileGatewayProcessInput } from "./mobileGatewayProcess.config.ts";
import type { VerifiedMobilePublication } from "../remote-agent/mobileOptionalPublication.ts";
import { withMobilePublicationOwner } from "../remote-agent/mobileGatewayLifecycle.publication.ts";
import { validateMobileGatewayConfiguration } from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { prepareRemoteMobileSocket } from "./mobileSocket.ts";
import { makeRemoteMobileRoutesLayer } from "./mobileRoutes.ts";
import { remoteUnixHttpServerLive } from "../server.platform.ts";
import { serveIsolatedRemoteRoutes } from "../server.remote.listener.ts";

export class MobileGatewayListenerError extends Data.TaggedError("MobileGatewayListenerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
const unavailable = (cause?: unknown) =>
  new MobileGatewayListenerError({
    message: "The private mobile gateway listener could not complete.",
    cause,
  });
const operation = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: unavailable });

/**
 * Explicit original-proof lifetime only. Reuse this backend's actual RPC services/boot lock;
 * no runtime/provider Layer is recreated and no credential or configuration escapes.
 */
export const runMobileGatewayListener = Effect.fn("runMobileGatewayListener")(function* (
  proof: VerifiedMobilePublication,
  input: MobileGatewayProcessInput,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const selected = yield* Effect.try({
        try: () => {
          const fixed = Object.freeze(
            Schema.decodeUnknownSync(MobileGatewayProcessInput)(input, {
              onExcessProperty: "error",
            }),
          );
          validateMobileGatewayConfiguration(fixed);
          return fixed;
        },
        catch: unavailable,
      });
      const config = yield* ServerConfig;
      const owner = yield* BackendInstance;
      const identity = yield* RemoteBackendIdentityService;
      const settings = yield* ServerSettingsService;
      const gateway = yield* RemoteMobileGatewayOwner;
      // This must be the same acquired service as client/callback runtime consumers.
      yield* BootstrapCommandLockService;
      const assertAllowed = async () => {
        await owner.assertHeld();
        if (!settings.currentSnapshot?.()?.settings.mobileRemoteControl.enabled)
          throw unavailable();
      };
      if (
        config.mode !== "remote" ||
        config.stateDir !== owner.stateDir ||
        config.remoteMobile ||
        !settings.currentSnapshot ||
        !settings.withSnapshotBarrier ||
        !settings.onSnapshotChange
      )
        return yield* Effect.fail(unavailable());
      // Read-only original capability/owner validation precedes the first socket side effect.
      yield* operation((signal) =>
        withMobilePublicationOwner(
          proof,
          async ({ authority, paths }) => {
            if (
              authority.owner.nonce !== owner.nonce ||
              authority.owner.stateDir !== owner.stateDir ||
              authority.owner.lockPath !== owner.lockPath ||
              authority.owner.pid !== owner.pid ||
              authority.owner.startedAt !== owner.startedAt ||
              compareRemoteBackendIdentity(paths.owner, identity) !== "match"
            )
              throw unavailable();
            await assertAllowed();
          },
          signal,
        ),
      );
      const remoteMobile = yield* Effect.try({
        try: () =>
          resolveRemoteMobileConfiguration({
            mode: config.mode,
            enabled: true,
            gatewayCredential: randomBytes(32).toString("hex"),
            clientToken: config.authToken,
          }),
        catch: unavailable,
      });
      if (!remoteMobile) return yield* Effect.fail(unavailable());
      const selectedConfig = Object.freeze({
        ...config,
        remoteMobile: Object.freeze(remoteMobile),
      });
      const socket = yield* Effect.acquireRelease(
        operation(async () => {
          await assertAllowed();
          return prepareRemoteMobileSocket(owner.stateDir, owner.assertHeld, {
            existing: "refuse-existing",
          });
        }),
        (socket) => operation(socket.release).pipe(Effect.orDie),
      );
      const serving = serveIsolatedRemoteRoutes(makeRemoteMobileRoutesLayer(version)).pipe(
        Layer.provide(remoteUnixHttpServerLive(socket.bindPath)),
        Layer.provide(Layer.succeed(ServerConfig, selectedConfig)),
      );
      // Scoped HTTP finalization is installed after socket ownership, so it closes first.
      yield* Layer.build(serving);
      yield* operation(async () => {
        await assertAllowed();
        await socket.seal();
      });
      // run returns only after its owned child/accepted work/cleanup settles, including repair failure.
      // Closing the private HTTP/socket afterward is safe credential denial even for uncertain exits;
      // gateway asset/CAS pins remain owned by the process's repair fence.
      yield* gateway.run(proof, selected).pipe(Effect.provideService(ServerConfig, selectedConfig));
    }),
  ).pipe(Effect.mapError(unavailable));
});

export type MobileGatewayListenerServices = Effect.Services<
  ReturnType<typeof runMobileGatewayListener>
>;
