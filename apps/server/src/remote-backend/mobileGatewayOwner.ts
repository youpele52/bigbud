import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import { MobileGatewayProcessInput } from "./mobileGatewayProcess.config.ts";
import { compareRemoteBackendIdentity } from "@bigbud/shared/remoteBackendIdentity";
import { version } from "../../package.json" with { type: "json" };
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteMobileGatewayStatus } from "./mobileGatewayStatus.ts";
import { RemoteMobileGatewayOwner } from "./mobileGatewayOwner.service.ts";
import { RemoteMobileGatewayRouteOwner } from "./mobileGatewayOwner.route.ts";
import { mobileGatewayOwnerCleanupConfirmed } from "./mobileGatewayOwner.exit.ts";
import { MobileGatewayOwnerState } from "./mobileGatewayOwner.state.ts";
import {
  readCurrentMobileGatewayAdmission,
  type ActiveMobileGatewayAdmission,
} from "./mobileGatewayOwner.read.ts";
import { remoteMobileDescriptor } from "./mobileDescriptor.ts";
import { mobileAdmissionStampEqual } from "../mobile/Services/MobileRemoteControlAdmission.ts";
import {
  nodeMobileGatewayProcessPort,
  mobileGatewayProcessPortRun,
} from "./mobileGatewayOwner.port.ts";

class MobileGatewayOwnerError extends Data.TaggedError("MobileGatewayOwnerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
const unavailable = (cause?: unknown) =>
  new MobileGatewayOwnerError({ message: "Owned mobile gateway admission is unavailable.", cause });
const waitForAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** Pure construction: no filesystem, settings, SQL, subprocess or route mutation. */
export const RemoteMobileGatewayOwnerLive = Layer.unwrap(
  Effect.gen(function* () {
    const routeOwner = yield* Effect.serviceOption(RemoteMobileGatewayRouteOwner);
    const state = new MobileGatewayOwnerState();
    let active: ActiveMobileGatewayAdmission | undefined;
    const readAdmission = () =>
      Effect.tryPromise({
        try: (signal) => readCurrentMobileGatewayAdmission(() => active, signal),
        catch: unavailable,
      }).pipe(Effect.orElseSucceed(() => null));
    /** One shared lifetime body; the port only supplies the process and its liveness read. */
    const runWith: typeof RemoteMobileGatewayOwner.Service.runWith = (proof, input, port) =>
      Effect.gen(function* () {
        const selected = yield* Effect.try({
          try: () =>
            Object.freeze(
              Schema.decodeUnknownSync(MobileGatewayProcessInput)(input, {
                onExcessProperty: "error",
              }),
            ),
          catch: unavailable,
        });
        const runProcess = yield* Effect.try({
          try: () => mobileGatewayProcessPortRun(port),
          catch: unavailable,
        });
        const config = yield* ServerConfig;
        const identity = yield* RemoteBackendIdentityService;
        const settings = yield* ServerSettingsService;
        if (
          config.mode !== "remote" ||
          !settings.onSnapshotChange ||
          !settings.currentSnapshot ||
          !settings.withSnapshotBarrier
        )
          return yield* Effect.fail(unavailable());
        return yield* Effect.acquireUseRelease(
          Effect.try({
            try: () => {
              const lease = state.begin();
              try {
                const unsubscribe = settings.onSnapshotChange!((snapshot) => {
                  if (!snapshot.settings.mobileRemoteControl.enabled) lease.invalidate("disabled");
                });
                return { lease, unsubscribe };
              } catch (cause) {
                lease.settle(false);
                throw cause;
              }
            },
            catch: unavailable,
          }),
          ({ lease }) => {
            if (!settings.currentSnapshot!()?.settings.mobileRemoteControl.enabled) {
              lease.invalidate("disabled");
              return Effect.void;
            }
            return runProcess(proof, selected, async (liveness, processSignal) => {
              if (Option.isNone(routeOwner)) throw unavailable();
              const signal = AbortSignal.any([lease.signal, processSignal]);
              signal.throwIfAborted();
              const initial = await liveness.read(signal);
              if (
                compareRemoteBackendIdentity(initial, identity) !== "match" ||
                initial.backendExternalOrigin !== selected.externalOrigin
              )
                throw unavailable();
              return routeOwner.value.withRoute(
                {
                  externalOrigin: initial.backendExternalOrigin,
                  port: selected.port,
                  expected: remoteMobileDescriptor(identity, version, false),
                },
                async (route, routeSignal) => {
                  const combined = AbortSignal.any([signal, routeSignal]);
                  const read = async (external: AbortSignal) => {
                    const currentSignal = AbortSignal.any([combined, external]);
                    currentSignal.throwIfAborted();
                    if (!settings.currentSnapshot!()?.settings.mobileRemoteControl.enabled)
                      throw unavailable();
                    await route.assertCurrent(currentSignal);
                    const stamp = await liveness.read(currentSignal);
                    currentSignal.throwIfAborted();
                    if (!settings.currentSnapshot!()?.settings.mobileRemoteControl.enabled)
                      throw unavailable();
                    return stamp;
                  };
                  const stamp = await read(combined);
                  if (!mobileAdmissionStampEqual(initial, stamp)) throw unavailable();
                  active = { lease, stamp, read };
                  lease.admit();
                  try {
                    await waitForAbort(combined);
                  } finally {
                    lease.invalidate("disabled");
                    if (active?.lease === lease) active = undefined;
                  }
                },
                signal,
              );
            });
          },
          ({ lease, unsubscribe }, exit) =>
            Effect.sync(() => {
              unsubscribe();
              if (active?.lease === lease) active = undefined;
              lease.settle(mobileGatewayOwnerCleanupConfirmed(exit));
            }),
        );
      });
    const owner: typeof RemoteMobileGatewayOwner.Service = {
      getPhase: state.getPhase,
      run: (proof, input) => runWith(proof, input, nodeMobileGatewayProcessPort),
      runWith,
    };
    const status: typeof RemoteMobileGatewayStatus.Service = {
      ready: readAdmission().pipe(Effect.map((stamp) => stamp !== null)),
      get verifiedExternalOrigin() {
        return active?.stamp.backendExternalOrigin;
      },
      readAdmission,
      watchAdmissionEnd: (stamp) =>
        Effect.scoped(
          Effect.gen(function* () {
            const ended = yield* Deferred.make<"disabled" | "revoked">();
            const selected = active;
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                state.subscribe(() => {
                  if (!selected?.lease.isAdmitted())
                    Effect.runSync(
                      Deferred.succeed(ended, selected?.lease.endReason() ?? "disabled"),
                    );
                }),
              ),
              (unsubscribe) => Effect.sync(unsubscribe),
            );
            const current = yield* readAdmission();
            if (!current) return "disabled" as const;
            if (!selected || active !== selected || !mobileAdmissionStampEqual(stamp, current))
              return "revoked" as const;
            return yield* Deferred.await(ended);
          }),
        ),
    };
    return Layer.mergeAll(
      Layer.succeed(RemoteMobileGatewayOwner, owner),
      Layer.succeed(RemoteMobileGatewayStatus, status),
    );
  }),
);
