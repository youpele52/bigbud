import { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { Data, Effect, Schema } from "effect";

import type { DirectResourceCleanupExecutorShape } from "../Services/DirectResourceCleanupExecutor.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { commandPayloadDigestMatches } from "../../orchestration/commandDigest.ts";
import type { DirectResourceCleanupRepositoryShape } from "../../persistence/Services/DirectResourceCleanupRepository.ts";

type FinalizeRepository = Pick<
  DirectResourceCleanupRepositoryShape,
  "listPreparedFinalizeCandidates" | "blockPrepared"
>;
type PreparedFinalizeCandidate = {
  readonly operationId: string;
  readonly createdAt: string;
  readonly finalizeCommandId: string;
  readonly finalizePayloadJson: string;
  readonly finalizePayloadDigestVersion: string;
  readonly finalizePayloadDigest: string;
};

class FinalizePayloadRecoveryError extends Data.TaggedError("FinalizePayloadRecoveryError")<{
  readonly cause: unknown;
}> {}

function decodeFinalizeCandidate(candidate: PreparedFinalizeCandidate) {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(candidate.finalizePayloadJson) as unknown,
      catch: (cause) => new FinalizePayloadRecoveryError({ cause }),
    });
    const command = yield* Schema.decodeUnknownEffect(OrchestrationCommand)(parsed).pipe(
      Effect.mapError((cause) => new FinalizePayloadRecoveryError({ cause })),
    );
    if (
      (command.type !== "thread.delete.finalize" && command.type !== "project.delete.finalize") ||
      command.commandId !== candidate.finalizeCommandId ||
      !commandPayloadDigestMatches(command, {
        version: candidate.finalizePayloadDigestVersion,
        digest: candidate.finalizePayloadDigest,
      })
    ) {
      return yield* Effect.fail(new Error("stored cleanup finalize command is invalid"));
    }
    return command;
  });
}

export const recoverPreparedCleanupFinalizes = Effect.fn(
  "DirectResourceCleanupRecovery.recoverPreparedFinalizes",
)(function* (input: {
  readonly repository: FinalizeRepository;
  readonly executorService: DirectResourceCleanupExecutorShape;
  readonly orchestration: OrchestrationEngineShape;
}) {
  let createdAfter = "";
  let operationAfter = "";
  for (;;) {
    const candidates = yield* input.repository.listPreparedFinalizeCandidates({
      createdAfter,
      operationAfter,
      limit: 100,
    });
    yield* Effect.forEach(
      candidates,
      (candidate) =>
        Effect.gen(function* () {
          const decoded = yield* Effect.exit(decodeFinalizeCandidate(candidate));
          if (decoded._tag === "Failure") {
            yield* input.repository.blockPrepared(
              candidate.operationId,
              "invalid_finalize_payload",
              new Date().toISOString(),
            );
            return;
          }
          const prepared = yield* Effect.exit(input.executorService.prepare());
          if (prepared._tag === "Failure") {
            yield* Effect.logWarning("cleanup finalize recovery deferred", {
              operationId: candidate.operationId,
              code: "executor_prepare_failure",
            });
            return;
          }
          const executor = prepared.value;
          yield* Effect.tryPromise(() => executor.assertAlive()).pipe(
            Effect.andThen(input.orchestration.dispatch(decoded.value)),
            Effect.catch((error) =>
              Effect.logWarning("cleanup finalize recovery deferred", {
                operationId: candidate.operationId,
                detail: String(error),
              }),
            ),
            Effect.ensuring(
              Effect.tryPromise(() => executor.shutdown()).pipe(
                Effect.ignore,
                Effect.ensuring(Effect.sync(() => executor.close())),
              ),
            ),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("cleanup finalize candidate recovery failed", {
              operationId: candidate.operationId,
              detail: String(error),
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
    const last = candidates.at(-1);
    if (!last || candidates.length < 100) break;
    createdAfter = last.createdAt;
    operationAfter = last.operationId;
  }
});
