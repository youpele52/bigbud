import { CommandId } from "@bigbud/contracts/core/baseSchemas.ts";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeWorktreeReservations } from "../../git/Layers/WorktreeReservations.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import { scanLegacyMetadataAdmission } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.admission.ts";
import { makeLegacyMetadataEvidenceReader } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.ts";
import { withMetadataTransaction } from "../../persistence/Layers/ThreadMetadataGeneration.transaction.ts";
import { resolveDefaultChatCwd, type ServerSettingsShape } from "../../ws/serverSettings.ts";
import type { SettingsSnapshot } from "../../ws/serverSettings.snapshot.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type {
  MetadataCapturedContext,
  MetadataCapturedPath,
} from "./ThreadMetadataGeneration.context.ts";
import type { MetadataCoordinatorHost } from "./ThreadMetadataGeneration.coordinator.types.ts";
import {
  metadataExecutionFingerprint,
  metadataFingerprint,
} from "./ThreadMetadataGeneration.policy.ts";
import { makeMetadataConfiguration } from "./ThreadMetadataGeneration.configuration.ts";
import { metadataContextIsCurrent } from "./ThreadMetadataGeneration.current.ts";

type Admission = MetadataCoordinatorHost["withDispatchAdmission"];
type Claim = Parameters<Admission>[2];

/** Provider-owned, server-only authority. Verify the captured epoch, exact transport,
 * options, configuration AND account identity, holding that authority through claim.
 * Settings hashes and process-local snapshot revisions alone do not prove account identity.
 * Never call a provider or dispatch a canonical command from this preparation boundary.
 */
export type MetadataExecutionAdmission = (
  context: MetadataCapturedContext,
  path: MetadataCapturedPath,
  snapshot: SettingsSnapshot,
  claim: Claim,
) => Claim;

/** Lock order: settings -> full-history engine -> identity -> SQL. No returned result
 * is an admission capability. The legacy scan and dispatch claim share one transaction.
 * Missing provider identity authority fails closed rather than inventing an account.
 */
export const makeMetadataDispatchAdmission = Effect.fn("makeMetadataDispatchAdmission")(
  function* (input: {
    readonly engine: OrchestrationEngineShape;
    readonly settings: ServerSettingsShape;
    readonly withExecutionIdentity?: MetadataExecutionAdmission;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* makeThreadMetadataGenerationRepository();
    const configuration = yield* makeMetadataConfiguration(input.settings);
    const readLegacy = yield* makeLegacyMetadataEvidenceReader();
    const reservations = makeWorktreeReservations(sql);
    const admit: Admission = (context, path, claim) =>
      Effect.suspend(() => {
        const operation =
          context.operation === "title" ? "generateThreadTitle" : "generateThreadElevatorSummary";
        const unavailable = () =>
          new TextGenerationError({
            operation,
            detail: "Metadata dispatch preparation is unavailable or no longer current.",
            metadataOutcome: "unavailable",
          });
        const withSettings = input.settings.withSnapshotBarrier;
        const withHistory = input.engine.withThreadHistoryBarrier;
        const withIdentity = input.withExecutionIdentity;
        const deletion = input.engine.threadDeletion;
        if (!withSettings || !withHistory || !withIdentity || !deletion)
          return Effect.fail(unavailable());
        if (
          path.executionTarget !== "local" ||
          context.workspace.executionTarget !== "local" ||
          ![context.primaryPath, context.threadPath].some(
            (captured) =>
              captured !== null &&
              metadataExecutionFingerprint(captured) === metadataExecutionFingerprint(path),
          )
        )
          return Effect.fail(unavailable());
        let claimStarted = false;
        const prepare = (snapshot: SettingsSnapshot) =>
          withMetadataTransaction(
            sql,
            Effect.gen(function* () {
              const model = yield* input.engine.getReadModel();
              const thread = model.threads.find((candidate) => candidate.id === context.threadId);
              if (
                !thread ||
                (yield* deletion.isFenced({ threadId: context.threadId, readModel: model }))
              )
                return yield* unavailable();
              const state = yield* repository.readMetadataState(context.threadId);
              if (
                !(yield* configuration.isCurrent(context.configEpoch)) ||
                !metadataContextIsCurrent(
                  context,
                  model,
                  state,
                  resolveDefaultChatCwd(snapshot.settings),
                )
              )
                return yield* unavailable();
              yield* reservations
                .assertAllows(
                  {
                    type: "thread.meta.update",
                    commandId: CommandId.makeUnsafe(
                      `server:metadata-admission:${metadataFingerprint([context.threadId, context.operation])}`,
                    ),
                    threadId: context.threadId,
                  },
                  undefined,
                  { value: context.workspace.worktreePath },
                )
                .pipe(Effect.mapError(unavailable));
              const legacy = yield* scanLegacyMetadataAdmission(readLegacy, context);
              if (!legacy.allowed) return yield* unavailable();
              claimStarted = true;
              yield* claim;
            }),
          ).pipe(
            Effect.mapError((error) =>
              error._tag === "SqlError"
                ? toPersistenceSqlError("ThreadMetadataGeneration.dispatchAdmission")(error)
                : error,
            ),
          );
        return withSettings((snapshot) =>
          withHistory(
            context.threadId,
            Effect.suspend(() => withIdentity(context, path, snapshot, prepare(snapshot))),
          ),
        ).pipe(
          Effect.catchTag("ServerSettingsError", () => Effect.fail(unavailable())),
          // Queue waiting and all preparation are bounded. Once the claim starts, a lost
          // commit response is uncertain, never evidence that dispatch intent was absent.
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () =>
              Effect.fail(
                claimStarted
                  ? new TextGenerationError({
                      operation,
                      detail: "Metadata dispatch preparation outcome could not be confirmed.",
                      metadataOutcome: "uncertain",
                    })
                  : unavailable(),
              ),
          }),
        );
      });
    return admit;
  },
);
