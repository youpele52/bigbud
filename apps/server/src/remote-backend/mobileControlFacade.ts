import * as fs from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { ServerConfig } from "../startup/config.ts";
import { MobileRemoteControlLive } from "../mobile/Layers/MobileRemoteControl.ts";
import {
  MobileRemoteControl,
  type MobileRemoteControlShape,
  type MobileRemoteSessionRecord,
} from "../mobile/Services/MobileRemoteControl.ts";
import {
  MobileRemoteControlAdmission,
  mobileAdmissionStampEqual,
  type RemoteMobileAdmissionStamp,
} from "../mobile/Services/MobileRemoteControlAdmission.ts";
import { makeRemoteMobileAdmission, RemoteMobileAdmissionError } from "./mobileControlAdmission.ts";

const unavailable = (cause?: unknown) =>
  new RemoteMobileAdmissionError({
    message: "Mobile access requires current host admission.",
    cause,
  });

/** One existing credential store; the remote facade narrows every externally usable grant. */
export const makeRemoteMobileControlFacade = Effect.gen(function* () {
  const delegate = yield* MobileRemoteControl;
  const gate = yield* makeRemoteMobileAdmission;
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const owner = yield* Effect.serviceOption(BackendInstance);
  const sessions = new WeakMap<MobileRemoteSessionRecord, RemoteMobileAdmissionStamp>();
  const admitted = <A>(operation: (stamp: RemoteMobileAdmissionStamp) => Effect.Effect<A, Error>) =>
    Effect.suspend(() => {
      const barrier = settings.withSnapshotBarrier;
      if (!barrier) return Effect.fail(unavailable());
      return barrier(() =>
        Effect.gen(function* () {
          const stamp = yield* gate.read;
          if (!stamp) return yield* Effect.fail(unavailable());
          const result = yield* operation(stamp).pipe(
            Effect.provideService(MobileRemoteControlAdmission, stamp),
          );
          const final = yield* gate.read;
          if (!final || !mobileAdmissionStampEqual(stamp, final))
            return yield* Effect.fail(unavailable());
          return { result, stamp };
        }),
      );
    });
  const storageExists = Effect.tryPromise({
    try: async () => {
      if (Option.isNone(owner)) return false;
      await owner.value.assertHeld();
      const root = join(config.stateDir, "mobile-remote");
      try {
        const info = await fs.lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
        return true;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return false;
        throw error;
      }
    },
    catch: (cause) => unavailable(cause),
  });
  return {
    createPairing: (input) =>
      admitted((stamp) => {
        if (
          input.baseUrl !== stamp.backendExternalOrigin ||
          input.backendBaseUrl !== stamp.backendExternalOrigin
        )
          return Effect.fail(unavailable());
        return delegate.createPairing(input);
      }).pipe(Effect.map(({ result }) => result)),
    getPairingStatus: (id) =>
      admitted(() => delegate.getPairingStatus(id)).pipe(
        Effect.map(({ result }) => result),
        Effect.orElseSucceed(() => null),
      ),
    exchangePairing: (input) =>
      admitted(() => delegate.exchangePairing(input)).pipe(
        Effect.map(({ result, stamp }) => {
          sessions.set(result, stamp);
          return result;
        }),
      ),
    validateSessionToken: (token) =>
      admitted(() => delegate.validateSessionToken(token)).pipe(
        Effect.map(({ result, stamp }) => {
          if (result) sessions.set(result, stamp);
          return result;
        }),
        Effect.orElseSucceed(() => null),
      ),
    listSessions: storageExists.pipe(
      Effect.flatMap((exists) => (exists ? delegate.listSessions : Effect.succeed([]))),
    ),
    revokeSession: (id) =>
      storageExists.pipe(
        Effect.flatMap((exists) => (exists ? delegate.revokeSession(id) : Effect.void)),
      ),
    watchSessionEnd: (session) => {
      const stamp = sessions.get(session);
      if (!stamp) return Effect.succeed("revoked" as const);
      return Effect.raceFirst(
        gate.watch(stamp),
        delegate.watchSessionEnd?.(session) ?? Effect.never,
      );
    },
  } satisfies MobileRemoteControlShape;
});

/** Stable value preserves Layer memoization and exactly one real underlying store. */
export const RemoteMobileControlFacadeLive = Layer.effect(
  MobileRemoteControl,
  makeRemoteMobileControlFacade,
).pipe(Layer.provide(MobileRemoteControlLive));
