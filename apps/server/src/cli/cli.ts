import { APP_SERVER_NAME } from "@bigbud/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig, RuntimeMode } from "../startup/config";
import {
  CANONICAL_THREAD_CLEANUP_LIMIT,
  runDeferredCanonicalThreadCleanup,
} from "../deletion/Layers/CanonicalThreadCleanup.ts";
import { runLegacyPurgeManifestRecovery } from "../deletion/Layers/LegacyPurgeManifestRecovery.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  layerConfig as SqlitePersistenceLayerLive,
  makeSqliteReadOnlyPersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import { PurgeJobRepositoryLive } from "../persistence/Layers/PurgeJobRepository.ts";
import { PortSchema, resolveServerConfig } from "./cli.config.ts";
import { runServer } from "../server";
import { writeStartupStatus } from "../startup/startupStatus";

export { resolveServerConfig } from "./cli.config.ts";

const modeFlag = Flag.choice("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to T3CODE_HOME)."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const authTokenFlag = Flag.string("auth-token").pipe(
  Flag.withDescription("Auth token required for WebSocket connections."),
  Flag.withAlias("token"),
  Flag.optional,
);
const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to BIGBUD_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);
const cleanupLimitFlag = Flag.integer("limit").pipe(
  Flag.withSchema(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CANONICAL_THREAD_CLEANUP_LIMIT })),
  ),
  Flag.withDescription("Maximum number of deferred roots to inspect or clean up."),
);
const compactionBatchFlag = Flag.integer("batch-size").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
  Flag.withDescription("Maximum canonical events to compact in one transaction."),
  Flag.optional,
);
const compactionPassesFlag = Flag.integer("passes").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  Flag.withDescription("Maximum bounded compaction transactions to run."),
  Flag.optional,
);

const commandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  cwd: Argument.string("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  authToken: authTokenFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

const canonicalThreadCleanupCommand = Command.make("canonical-thread-cleanup", {
  ...commandFlags,
  limit: cleanupLimitFlag,
  apply: Flag.boolean("apply").pipe(
    Flag.optional,
    Flag.withDescription("Apply canonical cleanup. Without this flag, the command is read-only."),
  ),
  serverStopped: Flag.boolean("server-stopped").pipe(
    Flag.optional,
    Flag.withDescription("Confirm the bigbud desktop app and server are stopped before applying."),
  ),
}).pipe(
  Command.withDescription(
    "Inspect or finalize bounded deferred thread canonical cleanup. Dry-run is the default.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const apply = Option.getOrElse(flags.apply, () => false);
      const serverStopped = Option.getOrElse(flags.serverStopped, () => false);
      if (apply && !serverStopped) {
        return yield* Effect.fail(
          new Error(
            "--apply requires --server-stopped after stopping the bigbud desktop app and server.",
          ),
        );
      }
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel);
      const persistenceLayer = apply
        ? SqlitePersistenceLayerLive
        : makeSqliteReadOnlyPersistenceLive(config.dbPath);
      const recoveryLayer = Layer.mergeAll(
        OrchestrationEventStoreLive,
        OrchestrationProjectionPipelineLive.pipe(Layer.provide(OrchestrationEventStoreLive)),
      ).pipe(Layer.provideMerge(persistenceLayer));
      const result = yield* runDeferredCanonicalThreadCleanup(apply, flags.limit).pipe(
        Effect.provide(recoveryLayer),
        Effect.provideService(ServerConfig, config),
      );
      yield* Effect.logInfo("canonical thread cleanup recovery completed", {
        mode: apply ? "apply" : "dry-run",
        cleanedCount: result.cleanedCount,
        skippedCount: result.skippedCount,
        failedCount: result.failedCount,
        candidates: result.candidates,
      });
    }),
  ),
);

const canonicalEventCompactionCommand = Command.make("canonical-event-compaction", {
  ...commandFlags,
  batchSize: compactionBatchFlag,
  passes: compactionPassesFlag,
  apply: Flag.boolean("apply").pipe(
    Flag.optional,
    Flag.withDescription(
      "Apply verified-prefix compaction. Without this flag, the command is read-only.",
    ),
  ),
  serverStopped: Flag.boolean("server-stopped").pipe(
    Flag.optional,
    Flag.withDescription("Confirm the bigbud desktop app and server are stopped before applying."),
  ),
}).pipe(
  Command.withDescription(
    "Inspect or compact the verified canonical event prefix. Dry-run is the default.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const apply = Option.getOrElse(flags.apply, () => false);
      const serverStopped = Option.getOrElse(flags.serverStopped, () => false);
      if (apply && !serverStopped) {
        return yield* Effect.fail(
          new Error(
            "--apply requires --server-stopped after stopping the bigbud desktop app and server.",
          ),
        );
      }
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel);
      const persistenceLayer = apply
        ? SqlitePersistenceLayerLive
        : makeSqliteReadOnlyPersistenceLive(config.dbPath);
      const compactionLayer = Layer.mergeAll(
        OrchestrationEventStoreLive,
        OrchestrationProjectionPipelineLive.pipe(Layer.provide(OrchestrationEventStoreLive)),
      ).pipe(Layer.provideMerge(persistenceLayer));
      const result = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const states = yield* sql<{
          retainedThroughSequence: number;
          compactThroughSequence: number;
        }>`
          SELECT retained_through_sequence AS "retainedThroughSequence",
            compact_through_sequence AS "compactThroughSequence"
          FROM orchestration_retention_state WHERE singleton_id = 1
        `;
        const state = states[0] ?? { retainedThroughSequence: 0, compactThroughSequence: 0 };
        const eventCounts = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_events
        `;
        const initialEventCount = eventCounts[0]?.count ?? 0;
        const baselines = yield* sql<{
          baselineId: number;
          sequence: number;
          payloadHash: string;
        }>`
          SELECT baseline_id AS "baselineId", sequence, payload_hash AS "payloadHash"
          FROM projection_baselines
          WHERE verification_status = 'verified'
          ORDER BY sequence DESC LIMIT 1
        `;
        const gapCounts = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_event_gaps
        `;
        const deletionMarkerCounts = yield* sql<{ covered: number; total: number }>`
          SELECT COUNT(*) AS total,
            SUM(covered_by_baseline_sequence IS NOT NULL) AS covered
          FROM orchestration_deletion_markers
        `;
        const baseline = baselines[0] ?? null;
        const replayGapCount = gapCounts[0]?.count ?? 0;
        const deletionMarkers = deletionMarkerCounts[0] ?? { covered: 0, total: 0 };
        const batchSize = Option.getOrElse(flags.batchSize, () => 500);
        const maxPasses = Option.getOrElse(flags.passes, () => 1);
        if (
          apply &&
          state.compactThroughSequence > 0 &&
          (baseline === null || baseline.sequence < state.compactThroughSequence)
        ) {
          return yield* Effect.fail(
            new Error(
              "Verified baseline does not cover the configured compaction target; run a baseline verification first.",
            ),
          );
        }
        if (!apply) {
          return {
            mode: "dry-run" as const,
            ...state,
            batchSize,
            maxPasses,
            eventCount: initialEventCount,
            baseline,
            replayGapCount,
            deletionMarkers,
            deletedCount: 0,
          };
        }
        const pipeline = yield* OrchestrationProjectionPipeline;
        let deletedCount = 0;
        let previousRetained = state.retainedThroughSequence;
        let completed = false;
        for (let pass = 0; pass < maxPasses && !completed; pass += 1) {
          yield* pipeline.compactVerifiedPrefix(batchSize);
          const next = yield* sql<{
            retainedThroughSequence: number;
            compactThroughSequence: number;
          }>`
            SELECT retained_through_sequence AS "retainedThroughSequence",
              compact_through_sequence AS "compactThroughSequence"
            FROM orchestration_retention_state WHERE singleton_id = 1
          `;
          const retained = next[0]?.retainedThroughSequence ?? previousRetained;
          const nextEventCounts = yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM orchestration_events
          `;
          deletedCount = initialEventCount - (nextEventCounts[0]?.count ?? initialEventCount);
          previousRetained = retained;
          completed = retained >= (next[0]?.compactThroughSequence ?? state.compactThroughSequence);
        }
        return {
          mode: "apply" as const,
          ...state,
          batchSize,
          maxPasses,
          baseline,
          replayGapCount,
          deletionMarkers,
          eventCount: initialEventCount,
          deletedCount,
          complete: completed,
        };
      }).pipe(Effect.provide(compactionLayer), Effect.provideService(ServerConfig, config));
      yield* Effect.logInfo("canonical event compaction completed", result);
    }),
  ),
);

const legacyOrphanRecoveryCommand = Command.make("legacy-orphan-recovery", {
  ...commandFlags,
  apply: Flag.boolean("apply").pipe(
    Flag.optional,
    Flag.withDescription(
      "Apply manifest-recorded orphan cleanup. Without this flag, the command is read-only.",
    ),
  ),
  serverStopped: Flag.boolean("server-stopped").pipe(
    Flag.optional,
    Flag.withDescription("Confirm the bigbud desktop app and server are stopped before applying."),
  ),
}).pipe(
  Command.withDescription(
    "Inspect or remove bounded resources recorded by retired legacy purge manifests.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const apply = Option.getOrElse(flags.apply, () => false);
      const serverStopped = Option.getOrElse(flags.serverStopped, () => false);
      if (apply && !serverStopped) {
        return yield* Effect.fail(
          new Error(
            "--apply requires --server-stopped after stopping the bigbud desktop app and server.",
          ),
        );
      }
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel);
      const persistenceLayer = apply
        ? SqlitePersistenceLayerLive
        : makeSqliteReadOnlyPersistenceLive(config.dbPath);
      const result = yield* runLegacyPurgeManifestRecovery(apply).pipe(
        Effect.provide(PurgeJobRepositoryLive.pipe(Layer.provideMerge(persistenceLayer))),
        Effect.provideService(ServerConfig, config),
      );
      yield* Effect.logInfo("legacy purge manifest orphan recovery completed", {
        mode: apply ? "apply" : "dry-run",
        ...result,
      });
    }),
  ),
);

const rootCommand = Command.make("bigbud", commandFlags).pipe(
  Command.withDescription(`Run the ${APP_SERVER_NAME}.`),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel);
      return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
    }).pipe(
      Effect.tapError(() => Effect.sync(() => writeStartupStatus("error", "bootstrap_failed"))),
    ),
  ),
  Command.withSubcommands([
    canonicalThreadCleanupCommand,
    canonicalEventCompactionCommand,
    legacyOrphanRecoveryCommand,
  ]),
);

export const cli = rootCommand;
