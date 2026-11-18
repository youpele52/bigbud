/**
 * Remote backend composition of runtime updates (M3 WP-4D).
 *
 * `RuntimeMaintenanceGateRemoteLive` is built under the state-directory lock and before
 * persistence: it completes a pending rollback restore (before the database opens) and starts
 * with admission closed while an activation journal exists. `RemoteRuntimeUpdateRemoteLive`
 * supplies WP-4C's dependencies (archive store root, WP-3A graph source, drain probe, owner
 * assertion and the activation seam) to `makeRemoteRuntimeUpdateLive`.
 */
import { homedir } from "node:os";
import { version } from "../../../package.json" with { type: "json" };
import { join } from "node:path";
import { Deferred, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeRuntimeMaintenanceGate,
  RuntimeMaintenanceGate,
} from "../../command-admission/RuntimeMaintenanceGate.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { RemoteRuntimeUpdateOperationsLive } from "../../persistence/Layers/RemoteRuntimeUpdateOperations.ts";
import { makeRemoteAgentInstallSourceLoader } from "../../remote-agent/remoteAgentInstallSource.ts";
import { BackendInstance } from "../../startup/backendInstance.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerRuntimeStartup } from "../../startup/serverRuntimeStartup.ts";
import { RemoteBackendIdentityService } from "../identity.service.ts";
import { openRuntimeArchiveStore, runtimeArchiveStoreRoot } from "../runtimeArchive.store.ts";
import {
  stepError,
  type RuntimeUpdateActivationContext,
} from "../runtimeUpdate.activate.context.ts";
import {
  makeRuntimeUpdateActivation,
  sweepRuntimeUpdateJournal,
} from "../runtimeUpdate.activate.resume.ts";
import { recoverRuntimeUpdateRestore } from "../runtimeUpdate.backup.ts";
import { makeRuntimeUpdateDrainProbe } from "../runtimeUpdate.drain.probe.ts";
import { makeRuntimeUpdateGraphSource } from "../runtimeUpdate.graphSource.ts";
import { hasRuntimeUpdateJournal } from "../runtimeUpdate.journal.ts";
import { makeRuntimeUpdateServiceUnit } from "../runtimeUpdate.unit.ts";
import {
  RemoteRuntimeUpdate,
  type RemoteRuntimeUpdateShape,
} from "../Services/RemoteRuntimeUpdate.ts";
import { makeRemoteRuntimeUpdateLive } from "./RemoteRuntimeUpdate.ts";

export const RuntimeMaintenanceGateRemoteLive = Layer.effect(
  RuntimeMaintenanceGate,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    // Restoring needs this backend's state lock, and must finish before the database opens.
    yield* BackendInstance;
    yield* Effect.promise(() => recoverRuntimeUpdateRestore(config.stateDir, config.dbPath));
    return makeRuntimeMaintenanceGate({
      initiallyClosed: hasRuntimeUpdateJournal(config.stateDir),
    });
  }),
);

export const RemoteRuntimeUpdateRemoteLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const owner = yield* BackendInstance;
    const identity = yield* RemoteBackendIdentityService;
    const engine = yield* OrchestrationEngineService;
    const sql = yield* SqlClient.SqlClient;
    const gate = yield* RuntimeMaintenanceGate;
    const startup = yield* ServerRuntimeStartup;
    const scope = yield* Effect.scope;
    const ready = yield* Deferred.make<RemoteRuntimeUpdateShape>();
    const home = homedir();
    const authorityId = identity.authority.authorityId;
    const ctx: RuntimeUpdateActivationContext = {
      stateDir: config.stateDir,
      dbPath: config.dbPath,
      sql,
      gate,
      probe: makeRuntimeUpdateDrainProbe({ engine, sql }),
      unit: makeRuntimeUpdateServiceUnit({ homeDir: home, authorityId }),
      service: Deferred.await(ready),
      trialReadiness: Effect.gen(function* () {
        yield* startup.awaitCommandReady;
        const rows = yield* sql<{ readonly quick_check: string }>`PRAGMA quick_check`;
        if (rows[0]?.quick_check !== "ok") return yield* stepError("The database check failed.");
      }).pipe(Effect.mapError((cause) => stepError(`Trial readiness failed: ${String(cause)}`))),
      runningEntryPath: () => process.argv[1] ?? "",
      runningVersion: version,
    };
    const sourceLoader = makeRemoteAgentInstallSourceLoader();
    const update = makeRemoteRuntimeUpdateLive({
      openStore: (checkpoint) =>
        openRuntimeArchiveStore({
          root: runtimeArchiveStoreRoot(home, authorityId),
          mutableRoots: [config.stateDir, join(home, ".bigbud/backend-services", authorityId)],
          checkpoint,
        }),
      graphSource: makeRuntimeUpdateGraphSource({
        environment: process.env,
        loadRustSource: (signal) => sourceLoader(signal),
      }),
      affectedWork: () => ctx.probe.affectedWork,
      assertOwner: owner.assertHeld,
      activation: makeRuntimeUpdateActivation(ctx, scope),
    });
    const publish = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Deferred.succeed(ready, yield* RemoteRuntimeUpdate);
        yield* sweepRuntimeUpdateJournal(ctx).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Runtime update sweep failed", cause)),
          Effect.forkIn(scope),
        );
      }),
    );
    return publish.pipe(
      Layer.provideMerge(update),
      Layer.provide(RemoteRuntimeUpdateOperationsLive),
    );
  }),
);
