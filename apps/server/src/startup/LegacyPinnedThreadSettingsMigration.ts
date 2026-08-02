import { CommandId, FAVORITE_THREAD_LIMIT, ThreadId } from "@bigbud/contracts";
import { decodeJsonResult } from "@bigbud/shared/schemaJson";
import { Effect, FileSystem, Option, Result, Schema } from "effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionOperationalStateQuery } from "../orchestration/Services/ProjectionOperationalStateQuery.ts";
import { ServerConfig } from "./config.ts";

const LegacySettings = Schema.Struct({
  favoriteThreadIds: Schema.optional(Schema.Array(Schema.Unknown)),
});

export const runLegacyPinnedThreadSettingsMigration = Effect.fn(
  "runLegacyPinnedThreadSettingsMigration",
)(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const operationalQuery = yield* Effect.serviceOption(ProjectionOperationalStateQuery);
  const raw = yield* fs.readFileString(config.settingsPath).pipe(Effect.orElseSucceed(() => ""));
  if (raw.length === 0) return;

  const decoded = decodeJsonResult(Schema.Unknown)(raw);
  if (Result.isFailure(decoded) || typeof decoded.success !== "object" || !decoded.success) return;
  const legacy = Schema.decodeUnknownOption(LegacySettings)(decoded.success);
  if (legacy._tag === "None" || legacy.value.favoriteThreadIds === undefined) return;

  const uniqueIds = Array.from(
    new Set(
      legacy.value.favoriteThreadIds.filter(
        (value): value is string => typeof value === "string" && Schema.is(ThreadId)(value),
      ),
    ),
  ).slice(0, FAVORITE_THREAD_LIMIT);
  const importableIds = yield* Effect.filter(uniqueIds, (threadId) =>
    Effect.gen(function* () {
      const thread = Option.isSome(operationalQuery)
        ? Option.getOrUndefined(
            yield* operationalQuery.value.getThreadOperationalState(ThreadId.makeUnsafe(threadId)),
          )?.threads[0]
        : (yield* orchestrationEngine.getReadModel()).threads.find(
            (candidate) => candidate.id === threadId,
          );
      return Boolean(thread && thread.deletedAt === null && (thread.deletingAt ?? null) === null);
    }),
  );
  const oldestFirst = importableIds.toReversed();
  const baseTimestamp = Date.now();
  yield* Effect.forEach(
    oldestFirst,
    (threadId, index) =>
      orchestrationEngine.dispatch({
        type: "thread.pin.migrate",
        commandId: CommandId.makeUnsafe(`server:legacy-pins-v1:${threadId}`),
        threadId: ThreadId.makeUnsafe(threadId),
        pinnedAt: new Date(baseTimestamp + index).toISOString(),
      }),
    { concurrency: 1, discard: true },
  );

  const verified = yield* Effect.forEach(
    importableIds,
    (threadId) =>
      Option.isSome(operationalQuery)
        ? operationalQuery.value
            .getThreadOperationalState(ThreadId.makeUnsafe(threadId))
            .pipe(
              Effect.map(
                (model) => (Option.getOrUndefined(model)?.threads[0]?.pinnedAt ?? null) !== null,
              ),
            )
        : orchestrationEngine
            .getReadModel()
            .pipe(
              Effect.map(
                (model) =>
                  (model.threads.find((thread) => thread.id === threadId)?.pinnedAt ?? null) !==
                  null,
              ),
            ),
    { concurrency: 1 },
  ).pipe(Effect.map((results) => results.every(Boolean)));
  if (!verified) {
    return yield* Effect.fail(new Error("Legacy pinned thread migration did not verify."));
  }

  const settings = { ...(decoded.success as Record<string, unknown>) };
  delete settings.favoriteThreadIds;
  const temporaryPath = `${config.settingsPath}.${process.pid}.${Date.now()}.tmp`;
  yield* fs.makeDirectory(config.stateDir, { recursive: true });
  yield* fs.writeFileString(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`);
  yield* fs
    .rename(temporaryPath, config.settingsPath)
    .pipe(
      Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore({ log: true }))),
    );
});
