import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import { compareRemoteBackendIdentity } from "@bigbud/shared/remoteBackendIdentity";
import { ServerConfig } from "../startup/config.ts";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteMobileGatewayStatus } from "./mobileGatewayStatus.ts";
import {
  decodeRemoteMobileAdmissionStamp,
  mobileAdmissionStampEqual,
  type RemoteMobileAdmissionStamp,
} from "../mobile/Services/MobileRemoteControlAdmission.ts";

export class RemoteMobileAdmissionError extends Data.TaggedError("RemoteMobileAdmissionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Reads are delegated to the real owner: no shell subprocess or invented ready producer here. */
export const makeRemoteMobileAdmission = Effect.gen(function* () {
  const gateway = yield* Effect.serviceOption(RemoteMobileGatewayStatus);
  const identity = yield* Effect.serviceOption(RemoteBackendIdentityService);
  const owner = yield* Effect.serviceOption(BackendInstance);
  const settings = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  const configured =
    Option.isSome(gateway) && gateway.value.readAdmission && gateway.value.watchAdmissionEnd
      ? gateway.value
      : null;
  const read = Effect.gen(function* () {
    const before = settings.currentSnapshot?.();
    if (
      config.mode !== "remote" ||
      !configured ||
      Option.isNone(identity) ||
      Option.isNone(owner) ||
      !settings.onSnapshotChange ||
      !before?.settings.mobileRemoteControl.enabled
    )
      return null;
    const ready = yield* configured.ready;
    if (!ready) return null;
    const supplied = yield* Effect.try({
      try: () => configured.readAdmission!(),
      catch: (cause) =>
        new RemoteMobileAdmissionError({ message: "Mobile admission is unavailable.", cause }),
    }).pipe(Effect.flatMap((operation) => operation));
    const stamp = decodeRemoteMobileAdmissionStamp(supplied);
    if (
      !stamp ||
      compareRemoteBackendIdentity(stamp, identity.value) !== "match" ||
      configured.verifiedExternalOrigin !== stamp.backendExternalOrigin
    )
      return null;
    yield* Effect.tryPromise({
      try: owner.value.assertHeld,
      catch: (cause) =>
        new RemoteMobileAdmissionError({
          message: "Mobile backend ownership is unavailable.",
          cause,
        }),
    });
    if (!settings.currentSnapshot?.()?.settings.mobileRemoteControl.enabled) return null;
    return stamp;
  }).pipe(Effect.orElseSucceed(() => null));

  const watch = (stamp: RemoteMobileAdmissionStamp) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (!configured || !settings.onSnapshotChange) return "revoked" as const;
        const disabled = yield* Deferred.make<"disabled">();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            settings.onSnapshotChange!((snapshot) => {
              if (!snapshot.settings.mobileRemoteControl.enabled)
                Effect.runSync(Deferred.succeed(disabled, "disabled"));
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
        // Subscribe before re-reading so an off/on transition cannot hide inside this gap.
        const current = yield* read;
        if (!current) return "disabled" as const;
        if (!mobileAdmissionStampEqual(stamp, current)) return "revoked" as const;
        return yield* Effect.raceFirst(
          Deferred.await(disabled),
          configured.watchAdmissionEnd!(stamp).pipe(
            Effect.orElseSucceed(() => "disabled" as const),
          ),
        );
      }),
    );
  return { read, watch };
});
