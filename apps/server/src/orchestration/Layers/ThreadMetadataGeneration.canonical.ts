import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import { withMetadataTransaction } from "../../persistence/Layers/ThreadMetadataGeneration.transaction.ts";
import { resolveDefaultChatCwd, type ServerSettingsShape } from "../../ws/serverSettings.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  MetadataCoordinatorError,
  type MetadataCoordinatorHost,
} from "./ThreadMetadataGeneration.coordinator.types.ts";
import { makeMetadataConfiguration } from "./ThreadMetadataGeneration.configuration.ts";
import { metadataContextIsCurrent } from "./ThreadMetadataGeneration.current.ts";
import {
  makeMetadataResultCommand,
  metadataCommitIdentity,
} from "./ThreadMetadataGeneration.identity.ts";

/** Canonical half of the host; deliberately has no provider or generation capability. */
export const makeMetadataCanonicalOperations = Effect.fn("makeMetadataCanonicalOperations")(
  function* (input: {
    readonly engine: OrchestrationEngineShape;
    readonly settings: ServerSettingsShape;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* makeThreadMetadataGenerationRepository();
    const configuration = yield* makeMetadataConfiguration(input.settings);
    const unavailable = () =>
      new MetadataCoordinatorError({ detail: "Metadata history preparation is unavailable." });
    const isCurrent: MetadataCoordinatorHost["isCurrent"] = (context) =>
      Effect.suspend(() => {
        const withSettings = input.settings.withSnapshotBarrier;
        const withHistory = input.engine.withThreadHistoryBarrier;
        // Missing authority is not evidence of stale input and must not settle a job.
        if (!withSettings || !withHistory) return Effect.fail(unavailable());
        return withSettings((snapshot) =>
          withHistory(
            context.threadId,
            withMetadataTransaction(
              sql,
              Effect.gen(function* () {
                const model = yield* input.engine.getReadModel();
                const state = yield* repository.readMetadataState(context.threadId);
                return (
                  (yield* configuration.isCurrent(context.configEpoch)) &&
                  metadataContextIsCurrent(
                    context,
                    model,
                    state,
                    resolveDefaultChatCwd(snapshot.settings),
                  )
                );
              }),
            ),
          ),
        ).pipe(
          Effect.mapError((error) => {
            if (error._tag === "SqlError")
              return toPersistenceSqlError("ThreadMetadataGeneration.isCurrent")(error);
            return error._tag === "ServerSettingsError" ? unavailable() : error;
          }),
          Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.fail(unavailable()) }),
        );
      });
    const commitResult: MetadataCoordinatorHost["commitResult"] = Effect.fn(
      "metadataCanonical.commitResult",
    )(function* (job, attempt, context) {
      const command = yield* makeMetadataResultCommand(job, attempt, context);
      // Do not hold preparation locks or pre-drop stale output. The engine authorizes and
      // settles stale output with an accepted no-op receipt in its canonical transaction.
      // Lost responses can replay only this immutable command, never model execution.
      yield* input.engine
        .dispatch(command, { metadataCommit: metadataCommitIdentity(job, attempt) })
        .pipe(
          Effect.mapError(
            () =>
              new MetadataCoordinatorError({
                detail: "Retained metadata result could not be committed.",
              }),
          ),
        );
    });
    return { isCurrent, commitResult } satisfies Pick<
      MetadataCoordinatorHost,
      "isCurrent" | "commitResult"
    >;
  },
);
