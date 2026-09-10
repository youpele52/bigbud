import type { MobileRecoverySelectedThread } from "@bigbud/contracts/server/mobile.recovery";
import { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { Effect, Option, Schema } from "effect";

import { trimOrchestrationSnapshotForMobile } from "../../mobile/mobileSnapshot.trim.ts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.helpers.ts";
import {
  assembleSnapshotRows,
  type ProjectionSnapshotAssemblyRows,
} from "./ProjectionSnapshotQueryAssembly.mobile.ts";
import { type ProjectionSnapshotQueryShape } from "../Services/ProjectionSnapshotQuery.ts";
import {
  type MobileProjectionSnapshotQuerySql,
  type MobileRecoveryQueryInput,
} from "./ProjectionSnapshotQuery.mobileSql.ts";
import { type ProjectionSnapshotQuerySql } from "./ProjectionSnapshotQuerySql.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const MOBILE_PROJECTOR_NAMES = Object.values(ORCHESTRATION_PROJECTOR_NAMES);

function projectionSequenceFromStateRows(
  stateRows: ProjectionSnapshotAssemblyRows["stateRows"],
): number {
  if (stateRows.length === 0) {
    throw new Error("mobile projection publication barrier is incomplete");
  }

  const stateByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );
  const sequences = MOBILE_PROJECTOR_NAMES.map((projector) => stateByProjector.get(projector));
  const presentSequences = sequences.filter(
    (sequence): sequence is number => sequence !== undefined,
  );

  if (presentSequences.length === 0) {
    throw new Error("mobile projection publication barrier is incomplete");
  }
  if (presentSequences.length !== MOBILE_PROJECTOR_NAMES.length) {
    throw new Error("mobile projection publication barrier is incomplete");
  }
  if (new Set(presentSequences).size !== 1) {
    throw new Error("mobile projection publication barrier has mixed cursors");
  }

  return presentSequences[0]!;
}

function onlyThread<T extends { readonly threadId: string }>(
  rows: ReadonlyArray<T>,
  threadId: string,
): ReadonlyArray<T> {
  return rows.filter((row) => row.threadId === threadId);
}

function mapMobileBaselineError(operation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(operation)(cause)
      : toPersistenceSqlError(operation)(cause);
}

function readMobileRows(
  queries: ProjectionSnapshotQuerySql,
  mobileQueries: MobileProjectionSnapshotQuerySql,
  input: MobileRecoveryQueryInput,
) {
  return Effect.all(
    [
      queries.listProjectRows(undefined),
      mobileQueries.listActiveThreadRows(undefined),
      mobileQueries.getSelectedThreadRow(input),
      mobileQueries.listMessageRows(input),
      mobileQueries.listProposedPlanRows(input),
      mobileQueries.listActivityRows(input),
      mobileQueries.listTaskRows(input),
      mobileQueries.listSessionRows(input),
      mobileQueries.listSelectedCheckpointRows(input),
      mobileQueries.listLatestTurnRows(input),
      mobileQueries.listProjectionStateRows(undefined),
      mobileQueries.listSelectedWatchRows(input),
    ],
    { concurrency: 1 },
  );
}

export function makeGetMobileRecoveryBaseline(
  queries: ProjectionSnapshotQuerySql,
  mobileQueries: MobileProjectionSnapshotQuerySql,
): NonNullable<ProjectionSnapshotQueryShape["getMobileRecoveryBaseline"]> {
  return (selectedThreadId) => {
    const input = { selectedThreadId } satisfies MobileRecoveryQueryInput;
    return Effect.gen(function* () {
      const [
        projectRows,
        activeThreadRows,
        selectedThreadRow,
        messageRows,
        proposedPlanRows,
        activityRows,
        taskRows,
        sessionRows,
        selectedCheckpointRows,
        latestTurnRows,
        stateRows,
        selectedWatchRows,
      ] = yield* readMobileRows(queries, mobileQueries, input).pipe(
        Effect.mapError(
          mapMobileBaselineError("ProjectionSnapshotQuery.getMobileRecoveryBaseline:query"),
        ),
      );

      const snapshotSequence = yield* Effect.try({
        try: () => projectionSequenceFromStateRows(stateRows),
        catch: (cause) =>
          toPersistenceSqlError(
            "ProjectionSnapshotQuery.getMobileRecoveryBaseline:publicationBarrier",
          )(cause),
      });

      const summaryRows = assembleSnapshotRows({
        projectRows,
        threadRows: activeThreadRows,
        messageRows,
        proposedPlanRows,
        activityRows,
        taskRows,
        sessionRows,
        checkpointRows: [],
        latestTurnRows,
        stateRows,
        threadWatchRows: [],
      });
      const summary = yield* decodeReadModel({ ...summaryRows, snapshotSequence }).pipe(
        Effect.mapError(
          toPersistenceDecodeError(
            "ProjectionSnapshotQuery.getMobileRecoveryBaseline:decodeSummary",
          ),
        ),
        Effect.map(trimOrchestrationSnapshotForMobile),
      );

      let selectedThread: MobileRecoverySelectedThread | null = null;
      if (Option.isSome(selectedThreadRow)) {
        if (selectedThreadRow.value.deletedAt !== null) {
          selectedThread = { status: "deleted" };
        } else {
          const selectedRows = {
            projectRows,
            threadRows: [selectedThreadRow.value],
            messageRows: onlyThread(messageRows, selectedThreadRow.value.threadId),
            proposedPlanRows: onlyThread(proposedPlanRows, selectedThreadRow.value.threadId),
            activityRows: onlyThread(activityRows, selectedThreadRow.value.threadId),
            taskRows: onlyThread(taskRows, selectedThreadRow.value.threadId),
            sessionRows: onlyThread(sessionRows, selectedThreadRow.value.threadId),
            checkpointRows: selectedCheckpointRows,
            latestTurnRows: onlyThread(latestTurnRows, selectedThreadRow.value.threadId),
            stateRows,
            threadWatchRows: selectedWatchRows,
          } satisfies ProjectionSnapshotAssemblyRows;
          const selectedModel = yield* decodeReadModel({
            ...assembleSnapshotRows(selectedRows),
            snapshotSequence,
          }).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getMobileRecoveryBaseline:decodeSelectedThread",
              ),
            ),
          );
          const thread = selectedModel.threads[0];
          selectedThread = thread ? { status: "present", thread } : { status: "missing" };
        }
      } else if (selectedThreadId !== null) {
        selectedThread = { status: "missing" };
      }

      return { snapshot: summary, snapshotSequence, selectedThread };
    }).pipe(
      Effect.mapError((cause) => {
        if (Schema.isSchemaError(cause) || cause._tag === "PersistenceSqlError") {
          return cause;
        }
        return toPersistenceSqlError("ProjectionSnapshotQuery.getMobileRecoveryBaseline:query")(
          cause,
        );
      }),
    );
  };
}
