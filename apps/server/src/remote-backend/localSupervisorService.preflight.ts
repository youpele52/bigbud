import { join } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  BackendInstance,
  StateDirLockLive,
  type BackendInstanceShape,
} from "../startup/backendInstance.ts";
import { ServerConfig, type ServerConfigShape } from "../startup/config.ts";
import { assertRemoteServerProfile } from "../startup/config.remote.ts";
import { PlatformServicesLive } from "../server.platform.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { withRemoteExecutionTargetDisconnects } from "../persistence/Layers/RemoteExecutionTargetDisconnects.ts";
import { RemoteAgentRuntimeOwnersLive } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { makeRemoteBackendIdentityLive, RemoteBackendIdentityService } from "./identity.service.ts";
import type { RemoteBackendIdentity } from "./authority.ts";

export class LocalSupervisorPreflightError extends Data.TaggedError(
  "LocalSupervisorPreflightError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface LocalSupervisorPreflightContext {
  readonly owner: BackendInstanceShape;
  readonly identity: RemoteBackendIdentity;
  readonly sql: SqlClient.SqlClient;
  readonly owners: RemoteAgentOwnerStore;
}

/** Finite ownership composition only; the operation must use canonical runtime admission.
 * This never binds listeners, starts providers or invents an installation/authority reservation. */
export function runLocalSupervisorServicePreflight<A>(input: {
  readonly config: ServerConfigShape;
  readonly requireExistingIdentity?: boolean;
  readonly validateIdentity?: (identity: RemoteBackendIdentity) => void;
  readonly operation: (context: LocalSupervisorPreflightContext, signal: AbortSignal) => Promise<A>;
}) {
  const { config } = input;
  const validate = Effect.try({
    try: () => {
      if (config.mode !== "remote")
        throw new Error("Remote service preflight requires remote mode.");
      assertRemoteServerProfile(config);
      if (config.dbPath !== join(config.stateDir, "state.sqlite"))
        throw new Error("Remote preflight database must belong to its locked state directory.");
    },
    catch: (cause) =>
      new LocalSupervisorPreflightError({
        message: "Invalid remote service preflight configuration.",
        cause,
      }),
  });
  const program = Effect.gen(function* () {
    const owner = yield* BackendInstance;
    const identity = yield* RemoteBackendIdentityService;
    yield* Effect.tryPromise(() => owner.assertHeld());
    yield* Effect.try({
      try: () => input.validateIdentity?.(identity),
      catch: (cause) =>
        new LocalSupervisorPreflightError({
          message: "Remote service identity does not match its reserved installation.",
          cause,
        }),
    });
    // Build persistence only after the outer owner/identity layers have completed.
    const persistence = withRemoteExecutionTargetDisconnects(
      makeSqlitePersistenceLive(config.dbPath, { reportStartupProgress: false }),
    );
    const resources = RemoteAgentRuntimeOwnersLive.pipe(Layer.provideMerge(persistence));
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const owners = yield* RemoteAgentRuntimeOwners;
      yield* Effect.tryPromise(() => owner.assertHeld());
      return yield* Effect.uninterruptibleMask((restore) => {
        const controller = new AbortController();
        const completion = Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return input.operation({ owner, identity, sql, owners }, controller.signal);
        });
        return restore(
          Effect.tryPromise({
            try: (signal) => {
              const abort = () => controller.abort(signal.reason);
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
              return completion.finally(() => signal.removeEventListener("abort", abort));
            },
            catch: (cause) =>
              new LocalSupervisorPreflightError({
                message:
                  "Remote service preflight did not complete; preserve pending ownership and inspect the cause.",
                cause,
              }),
          }),
        ).pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              controller.abort();
              // Settle inside the provided computation BEFORE its persistence scope unwinds.
              // An ordinary scope finalizer can race the layer's parallel resource teardown.
              await completion.then(
                () => undefined,
                () => undefined,
              );
            }),
          ),
        );
      });
    }).pipe(Effect.provide(resources));
  });
  const ownership = makeRemoteBackendIdentityLive({
    requireExisting: input.requireExistingIdentity ?? false,
  }).pipe(Layer.provideMerge(StateDirLockLive));
  const environment = Layer.mergeAll(ownership, PlatformServicesLive).pipe(
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
  );
  // Validation occurs before any layer acquires a lock, loads identity or opens the database.
  return Effect.andThen(validate, Effect.scoped(program.pipe(Effect.provide(environment))));
}
