import { AutomationRun } from "@bigbud/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Option } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ClaimAutomationOccurrenceInput,
  GetAutomationRunByOccurrenceInput,
  GetStartedAutomationRunByMessageIdInput,
  ListAutomationRunsInput,
  ListStartedAutomationRunsInput,
  RecordAutomationRunDispatchedInput,
  RecordAutomationRunFailedInput,
  RecordAutomationRunFinishedInput,
  RecordAutomationRunStartedInput,
  ReleaseAutomationScheduleLeaseInput,
} from "../Services/AutomationScheduleRepository.ts";

export const makeAutomationRunQueries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRunStarted = SqlSchema.void({
    Request: RecordAutomationRunStartedInput,
    execute: (input) =>
      sql`
        INSERT INTO automation_runs (
          run_id,
          automation_id,
          thread_id,
          message_id,
          command_id,
          trigger_kind,
          scheduled_for,
          status,
          started_at
        )
        VALUES (
          ${input.runId},
          ${input.automationId},
          ${input.threadId},
          ${input.messageId},
          ${input.commandId},
          ${input.triggerKind},
          ${input.scheduledFor},
          'started',
          ${input.startedAt}
        )
      `,
  });

  const markRunDispatched = SqlSchema.void({
    Request: RecordAutomationRunDispatchedInput,
    execute: ({ runId, dispatchedAt }) =>
      sql`
        UPDATE automation_runs
        SET dispatched_at = ${dispatchedAt}
        WHERE run_id = ${runId}
          AND status = 'started'
      `,
  });

  const markRunFinished = SqlSchema.void({
    Request: RecordAutomationRunFinishedInput,
    execute: ({ runId, finishedAt, providerTerminalEventId }) =>
      sql`
        UPDATE automation_runs
        SET
          status = 'finished',
          finished_at = ${finishedAt},
          provider_terminal_event_id = COALESCE(${providerTerminalEventId ?? null}, provider_terminal_event_id)
        WHERE run_id = ${runId}
          AND status = 'started'
      `,
  });

  const markRunFailed = SqlSchema.void({
    Request: RecordAutomationRunFailedInput,
    execute: ({ runId, finishedAt, errorMessage }) =>
      sql`
        UPDATE automation_runs
        SET status = 'failed', finished_at = ${finishedAt}, error_message = ${errorMessage}
        WHERE run_id = ${runId}
          AND status = 'started'
      `,
  });

  const listRunRows = SqlSchema.findAll({
    Request: ListAutomationRunsInput,
    Result: AutomationRun,
    execute: ({ automationId, limit }) =>
      sql`
        SELECT
          run_id AS "runId",
          automation_id AS "automationId",
          thread_id AS "threadId",
          message_id AS "messageId",
          command_id AS "commandId",
          trigger_kind AS "triggerKind",
          scheduled_for AS "scheduledFor",
          status,
          started_at AS "startedAt",
          dispatched_at AS "dispatchedAt",
          finished_at AS "finishedAt",
          provider_terminal_event_id AS "providerTerminalEventId",
          error_message AS "errorMessage"
        FROM automation_runs
        WHERE automation_id = ${automationId}
        ORDER BY started_at DESC, run_id DESC
        LIMIT ${limit}
      `,
  });

  const listStartedRunRows = SqlSchema.findAll({
    Request: ListStartedAutomationRunsInput,
    Result: AutomationRun,
    execute: ({ limit }) =>
      sql`
        SELECT
          run_id AS "runId",
          automation_id AS "automationId",
          thread_id AS "threadId",
          message_id AS "messageId",
          command_id AS "commandId",
          trigger_kind AS "triggerKind",
          scheduled_for AS "scheduledFor",
          status,
          started_at AS "startedAt",
          dispatched_at AS "dispatchedAt",
          finished_at AS "finishedAt",
          provider_terminal_event_id AS "providerTerminalEventId",
          error_message AS "errorMessage"
        FROM automation_runs
        WHERE status = 'started'
        ORDER BY started_at ASC, run_id ASC
        LIMIT ${limit}
      `,
  });

  const getRunByOccurrenceRow = SqlSchema.findOneOption({
    Request: GetAutomationRunByOccurrenceInput,
    Result: AutomationRun,
    execute: ({ automationId, scheduledFor, triggerKind }) =>
      sql`
        SELECT
          run_id AS "runId",
          automation_id AS "automationId",
          thread_id AS "threadId",
          message_id AS "messageId",
          command_id AS "commandId",
          trigger_kind AS "triggerKind",
          scheduled_for AS "scheduledFor",
          status,
          started_at AS "startedAt",
          dispatched_at AS "dispatchedAt",
          finished_at AS "finishedAt",
          provider_terminal_event_id AS "providerTerminalEventId",
          error_message AS "errorMessage"
        FROM automation_runs
        WHERE automation_id = ${automationId}
          AND scheduled_for = ${scheduledFor}
          AND trigger_kind = ${triggerKind}
        LIMIT 1
      `,
  });

  const getStartedRunByMessageIdRow = SqlSchema.findOneOption({
    Request: GetStartedAutomationRunByMessageIdInput,
    Result: AutomationRun,
    execute: ({ messageId }) =>
      sql`
        SELECT
          run_id AS "runId",
          automation_id AS "automationId",
          thread_id AS "threadId",
          message_id AS "messageId",
          command_id AS "commandId",
          trigger_kind AS "triggerKind",
          scheduled_for AS "scheduledFor",
          status,
          started_at AS "startedAt",
          dispatched_at AS "dispatchedAt",
          finished_at AS "finishedAt",
          provider_terminal_event_id AS "providerTerminalEventId",
          error_message AS "errorMessage"
        FROM automation_runs
        WHERE message_id = ${messageId}
          AND status = 'started'
        LIMIT 1
      `,
  });

  const releaseScheduleLease = SqlSchema.void({
    Request: ReleaseAutomationScheduleLeaseInput,
    execute: ({ automationId, updatedAt }) =>
      sql`
        UPDATE automation_schedules
        SET lease_until = NULL, updated_at = ${updatedAt}
        WHERE automation_id = ${automationId}
      `,
  });

  const claimOccurrence = (input: typeof ClaimAutomationOccurrenceInput.Type) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const updated = yield* sql<{ readonly automationId: string }>`
            UPDATE automation_schedules
            SET next_run_at = ${input.nextRunAt}, lease_until = NULL, updated_at = ${input.updatedAt}
            WHERE automation_id = ${input.automationId}
              AND deleted_at IS NULL
              AND paused_at IS NULL
              AND completed_at IS NULL
              AND next_run_at = ${input.scheduledFor}
            RETURNING automation_id AS "automationId"
          `;
          if (updated.length === 0) {
            const existing = yield* sql<AutomationRun>`
              SELECT
                run_id AS "runId",
                automation_id AS "automationId",
                thread_id AS "threadId",
                message_id AS "messageId",
                command_id AS "commandId",
                trigger_kind AS "triggerKind",
                scheduled_for AS "scheduledFor",
                status,
                started_at AS "startedAt",
                dispatched_at AS "dispatchedAt",
                finished_at AS "finishedAt",
                provider_terminal_event_id AS "providerTerminalEventId",
                error_message AS "errorMessage"
              FROM automation_runs
              WHERE automation_id = ${input.automationId}
                AND scheduled_for = ${input.scheduledFor}
                AND trigger_kind = 'scheduled'
              LIMIT 1
            `;
            return existing.length > 0 ? Option.some(existing[0]!) : Option.none();
          }

          const inserted = yield* sql<AutomationRun>`
            INSERT INTO automation_runs (
              run_id,
              automation_id,
              thread_id,
              message_id,
              command_id,
              trigger_kind,
              scheduled_for,
              status,
              started_at
            )
            VALUES (
              ${input.runId},
              ${input.automationId},
              ${input.threadId},
              ${input.messageId},
              ${input.commandId},
              'scheduled',
              ${input.scheduledFor},
              'started',
              ${input.startedAt}
            )
            ON CONFLICT DO NOTHING
            RETURNING
              run_id AS "runId",
              automation_id AS "automationId",
              thread_id AS "threadId",
              message_id AS "messageId",
              command_id AS "commandId",
              trigger_kind AS "triggerKind",
              scheduled_for AS "scheduledFor",
              status,
              started_at AS "startedAt",
              dispatched_at AS "dispatchedAt",
              finished_at AS "finishedAt",
              provider_terminal_event_id AS "providerTerminalEventId",
              error_message AS "errorMessage"
          `;
          if (inserted.length > 0) {
            return Option.some(inserted[0]!);
          }

          const existing = yield* sql<AutomationRun>`
            SELECT
              run_id AS "runId",
              automation_id AS "automationId",
              thread_id AS "threadId",
              message_id AS "messageId",
              command_id AS "commandId",
              trigger_kind AS "triggerKind",
              scheduled_for AS "scheduledFor",
              status,
              started_at AS "startedAt",
              dispatched_at AS "dispatchedAt",
              finished_at AS "finishedAt",
              provider_terminal_event_id AS "providerTerminalEventId",
              error_message AS "errorMessage"
            FROM automation_runs
            WHERE automation_id = ${input.automationId}
              AND scheduled_for = ${input.scheduledFor}
              AND trigger_kind = 'scheduled'
            LIMIT 1
          `;
          return existing.length > 0 ? Option.some(existing[0]!) : Option.none();
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          toPersistenceSqlError("AutomationScheduleRepository.claimOccurrence:query")(cause),
        ),
      );

  const recordRunStarted = (input: typeof RecordAutomationRunStartedInput.Type) =>
    insertRunStarted(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationScheduleRepository.recordRunStarted:query")),
    );

  const recordRunDispatched = (input: typeof RecordAutomationRunDispatchedInput.Type) =>
    markRunDispatched(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationScheduleRepository.recordRunDispatched:query"),
      ),
    );

  const recordRunFinished = (input: typeof RecordAutomationRunFinishedInput.Type) =>
    markRunFinished(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationScheduleRepository.recordRunFinished:query"),
      ),
    );

  const recordRunFailed = (input: typeof RecordAutomationRunFailedInput.Type) =>
    markRunFailed(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationScheduleRepository.recordRunFailed:query")),
    );

  const listRuns = (input: typeof ListAutomationRunsInput.Type) =>
    listRunRows(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.listRuns:query")(cause),
      ),
    );

  const listStartedRuns = (input: typeof ListStartedAutomationRunsInput.Type) =>
    listStartedRunRows(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.listStartedRuns:query")(cause),
      ),
    );

  const getRunByOccurrence = (input: typeof GetAutomationRunByOccurrenceInput.Type) =>
    getRunByOccurrenceRow(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.getRunByOccurrence:query")(cause),
      ),
    );

  const getStartedRunByMessageId = (input: typeof GetStartedAutomationRunByMessageIdInput.Type) =>
    getStartedRunByMessageIdRow(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.getStartedRunByMessageId:query")(cause),
      ),
    );

  const releaseLease = (input: typeof ReleaseAutomationScheduleLeaseInput.Type) =>
    releaseScheduleLease(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.releaseLease:query")(cause),
      ),
    );

  return {
    recordRunStarted,
    recordRunDispatched,
    recordRunFinished,
    recordRunFailed,
    listRuns,
    listStartedRuns,
    getRunByOccurrence,
    getStartedRunByMessageId,
    releaseLease,
    claimOccurrence,
  };
});
