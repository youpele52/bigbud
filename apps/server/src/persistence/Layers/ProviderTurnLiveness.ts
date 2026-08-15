import type { ProviderTurnLiveness } from "@bigbud/contracts/orchestration/providerTurnLiveness";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProviderTurnLivenessRepository,
  type ProviderTurnLivenessRepositoryShape,
} from "../Services/ProviderTurnLiveness.ts";

type LivenessRow = {
  threadId: string;
  turnId: string;
  provider: ProviderTurnLiveness["provider"];
  turnStartedAt: string;
  lastRuntimeEventAt: string | null;
  lastMeaningfulProgressAt: string;
  lastInspectionAt: string | null;
  inspectionStatus: ProviderTurnLiveness["inspectionStatus"];
  consecutiveInspectionFailures: number;
  terminalAt: string | null;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const startTurn: ProviderTurnLivenessRepositoryShape["startTurn"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE provider_turn_liveness SET terminal_at = ${input.startedAt}
          WHERE thread_id = ${input.threadId} AND terminal_at IS NULL`;
          yield* sql`INSERT INTO provider_turn_liveness (
          thread_id, turn_id, provider_name, turn_started_at, last_runtime_event_at,
          last_meaningful_progress_at, last_inspection_at, inspection_status,
          consecutive_inspection_failures, terminal_at
        ) VALUES (
          ${input.threadId}, ${input.turnId}, ${input.provider}, ${input.startedAt}, NULL,
          ${input.startedAt}, NULL, 'idle', 0, NULL
        ) ON CONFLICT (thread_id, turn_id) DO UPDATE SET
          provider_name = excluded.provider_name,
          turn_started_at = excluded.turn_started_at,
          last_runtime_event_at = NULL,
          last_meaningful_progress_at = excluded.last_meaningful_progress_at,
          last_inspection_at = NULL,
          inspection_status = 'idle',
          consecutive_inspection_failures = 0,
          terminal_at = NULL
        WHERE provider_turn_liveness.terminal_at IS NULL`;
        }),
      )
      .pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ProviderTurnLiveness.startTurn")),
      );

  const observeEvent: ProviderTurnLivenessRepositoryShape["observeEvent"] = (event, meaningful) =>
    event.turnId
      ? sql`UPDATE provider_turn_liveness SET
          last_runtime_event_at = CASE
            WHEN last_runtime_event_at IS NULL OR last_runtime_event_at < ${event.createdAt}
            THEN ${event.createdAt} ELSE last_runtime_event_at END,
          last_meaningful_progress_at = CASE
            WHEN ${meaningful ? 1 : 0} = 1 AND last_meaningful_progress_at < ${event.createdAt}
            THEN ${event.createdAt} ELSE last_meaningful_progress_at END,
          inspection_status = CASE WHEN ${meaningful ? 1 : 0} = 1 THEN 'idle' ELSE inspection_status END,
          consecutive_inspection_failures = CASE WHEN ${meaningful ? 1 : 0} = 1 THEN 0 ELSE consecutive_inspection_failures END
        WHERE thread_id = ${event.threadId} AND turn_id = ${event.turnId} AND terminal_at IS NULL`.pipe(
          Effect.asVoid,
          Effect.mapError(toPersistenceSqlError("ProviderTurnLiveness.observeEvent")),
        )
      : Effect.void;

  const recordInspection: ProviderTurnLivenessRepositoryShape["recordInspection"] = (input) =>
    sql`UPDATE provider_turn_liveness SET
        last_inspection_at = ${input.observedAt}, inspection_status = ${input.status},
        consecutive_inspection_failures = CASE WHEN ${input.failed ? 1 : 0} = 1
          THEN consecutive_inspection_failures + 1 ELSE 0 END
      WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId} AND terminal_at IS NULL`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProviderTurnLiveness.recordInspection")),
    );

  const markTerminal: ProviderTurnLivenessRepositoryShape["markTerminal"] = (input) =>
    (input.turnId
      ? sql`UPDATE provider_turn_liveness SET terminal_at = ${input.terminalAt}
          WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId} AND terminal_at IS NULL`
      : sql`UPDATE provider_turn_liveness SET terminal_at = ${input.terminalAt}
          WHERE thread_id = ${input.threadId} AND terminal_at IS NULL`
    ).pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProviderTurnLiveness.markTerminal")),
    );

  const claimTerminal: ProviderTurnLivenessRepositoryShape["claimTerminal"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const claimed = yield* sql<{ turnId: string }>`UPDATE provider_turn_liveness
          SET terminal_at = ${input.terminalAt}
          WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId}
            AND terminal_at IS NULL
          RETURNING turn_id AS "turnId"`;
          if (claimed.length === 1) return true;
          const existing = yield* sql<{
            terminalAt: string | null;
          }>`SELECT terminal_at AS "terminalAt"
          FROM provider_turn_liveness
          WHERE thread_id = ${input.threadId} AND turn_id = ${input.turnId}`;
          if (existing.length > 0) return false;
          yield* sql`INSERT INTO provider_turn_liveness (
          thread_id, turn_id, provider_name, turn_started_at, last_runtime_event_at,
          last_meaningful_progress_at, last_inspection_at, inspection_status,
          consecutive_inspection_failures, terminal_at
        ) VALUES (
          ${input.threadId}, ${input.turnId}, ${input.provider}, ${input.terminalAt},
          ${input.terminalAt}, ${input.terminalAt}, NULL, 'completed', 0, ${input.terminalAt}
        )`;
          return true;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProviderTurnLiveness.claimTerminal")));

  const markMonitoringLost: ProviderTurnLivenessRepositoryShape["markMonitoringLost"] = (input) =>
    sql`UPDATE provider_turn_liveness SET inspection_status = 'checking', last_inspection_at = NULL,
        consecutive_inspection_failures = 0
      WHERE provider_name = ${input.provider} AND terminal_at IS NULL`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProviderTurnLiveness.markMonitoringLost")),
    );

  const listActive: ProviderTurnLivenessRepositoryShape["listActive"] = () =>
    sql<LivenessRow>`SELECT thread_id AS "threadId", turn_id AS "turnId",
      provider_name AS provider, turn_started_at AS "turnStartedAt",
      last_runtime_event_at AS "lastRuntimeEventAt",
      last_meaningful_progress_at AS "lastMeaningfulProgressAt",
      last_inspection_at AS "lastInspectionAt", inspection_status AS "inspectionStatus",
      consecutive_inspection_failures AS "consecutiveInspectionFailures", terminal_at AS "terminalAt"
      FROM provider_turn_liveness WHERE terminal_at IS NULL
      ORDER BY last_meaningful_progress_at ASC, thread_id ASC, turn_id ASC`.pipe(
      Effect.map((rows) => rows as ReadonlyArray<ProviderTurnLiveness>),
      Effect.mapError(toPersistenceSqlError("ProviderTurnLiveness.listActive")),
    );

  return {
    startTurn,
    observeEvent,
    recordInspection,
    markTerminal,
    claimTerminal,
    markMonitoringLost,
    listActive,
  };
});

export const ProviderTurnLivenessRepositoryLive = Layer.effect(
  ProviderTurnLivenessRepository,
  make,
);
