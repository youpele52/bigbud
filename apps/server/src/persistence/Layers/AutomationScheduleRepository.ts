import { AutomationRun, AutomationSchedule } from "@bigbud/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  AutomationScheduleRepository,
  type AutomationScheduleRepositoryShape,
  ClaimDueAutomationSchedulesInput,
  CreateAutomationScheduleInput,
  DeleteAutomationScheduleInput,
  GetAutomationScheduleInput,
  ListAutomationRunsInput,
  ListAutomationSchedulesByThreadInput,
  PauseAutomationScheduleInput,
  RecordAutomationRunFailedInput,
  RecordAutomationRunFinishedInput,
  RecordAutomationRunStartedInput,
  ResumeAutomationScheduleInput,
  UpdateAutomationScheduleInput,
  UpdateAutomationScheduleNextRunInput,
} from "../Services/AutomationScheduleRepository.ts";

const timestampNow = () => new Date().toISOString();

const makeAutomationScheduleRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createSchedule = SqlSchema.findOne({
    Request: CreateAutomationScheduleInput,
    Result: AutomationSchedule,
    execute: (input) => {
      const createdAt = timestampNow();
      return sql`
        INSERT INTO automation_schedules (
          automation_id,
          project_id,
          target_thread_id,
          title,
          prompt,
          cron_expression,
          timezone,
          next_run_at,
          paused_at,
          deleted_at,
          lease_until,
          created_at,
          updated_at
        )
        VALUES (
          ${input.automationId},
          ${input.projectId},
          ${input.targetThreadId},
          ${input.title},
          ${input.prompt},
          ${input.cronExpression},
          ${input.timezone},
          ${input.nextRunAt},
          NULL,
          NULL,
          NULL,
          ${createdAt},
          ${createdAt}
        )
        RETURNING
          automation_id AS "automationId",
          project_id AS "projectId",
          target_thread_id AS "targetThreadId",
          title,
          prompt,
          cron_expression AS "cronExpression",
          timezone,
          next_run_at AS "nextRunAt",
          paused_at AS "pausedAt",
          deleted_at AS "deletedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
    },
  });

  const getScheduleById = SqlSchema.findOneOption({
    Request: GetAutomationScheduleInput,
    Result: AutomationSchedule,
    execute: ({ automationId }) =>
      sql`
        SELECT
          automation_id AS "automationId",
          project_id AS "projectId",
          target_thread_id AS "targetThreadId",
          title,
          prompt,
          cron_expression AS "cronExpression",
          timezone,
          next_run_at AS "nextRunAt",
          paused_at AS "pausedAt",
          deleted_at AS "deletedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_schedules
        WHERE automation_id = ${automationId}
      `,
  });

  const listSchedulesByThread = SqlSchema.findAll({
    Request: ListAutomationSchedulesByThreadInput,
    Result: AutomationSchedule,
    execute: ({ threadId }) =>
      sql`
        SELECT
          automation_id AS "automationId",
          project_id AS "projectId",
          target_thread_id AS "targetThreadId",
          title,
          prompt,
          cron_expression AS "cronExpression",
          timezone,
          next_run_at AS "nextRunAt",
          paused_at AS "pausedAt",
          deleted_at AS "deletedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_schedules
        WHERE target_thread_id = ${threadId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, automation_id ASC
      `,
  });

  const claimDueSchedules = SqlSchema.findAll({
    Request: ClaimDueAutomationSchedulesInput,
    Result: AutomationSchedule,
    execute: ({ now, leaseUntil, limit }) =>
      sql`
        UPDATE automation_schedules
        SET lease_until = ${leaseUntil}
        WHERE automation_id IN (
          SELECT automation_id
          FROM automation_schedules
          WHERE next_run_at IS NOT NULL
            AND next_run_at <= ${now}
            AND paused_at IS NULL
            AND deleted_at IS NULL
            AND (lease_until IS NULL OR lease_until < ${now})
          ORDER BY next_run_at ASC, automation_id ASC
          LIMIT ${limit}
        )
        RETURNING
          automation_id AS "automationId",
          project_id AS "projectId",
          target_thread_id AS "targetThreadId",
          title,
          prompt,
          cron_expression AS "cronExpression",
          timezone,
          next_run_at AS "nextRunAt",
          paused_at AS "pausedAt",
          deleted_at AS "deletedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
  });

  const updateSchedule = SqlSchema.findOne({
    Request: UpdateAutomationScheduleInput,
    Result: AutomationSchedule,
    execute: (input) =>
      sql`
        UPDATE automation_schedules
        SET
          title = COALESCE(${input.title ?? null}, title),
          prompt = COALESCE(${input.prompt ?? null}, prompt),
          cron_expression = COALESCE(${input.cronExpression ?? null}, cron_expression),
          timezone = COALESCE(${input.timezone ?? null}, timezone),
          next_run_at = COALESCE(${input.nextRunAt ?? null}, next_run_at),
          updated_at = ${input.updatedAt}
        WHERE automation_id = ${input.automationId}
          AND deleted_at IS NULL
        RETURNING
          automation_id AS "automationId",
          project_id AS "projectId",
          target_thread_id AS "targetThreadId",
          title,
          prompt,
          cron_expression AS "cronExpression",
          timezone,
          next_run_at AS "nextRunAt",
          paused_at AS "pausedAt",
          deleted_at AS "deletedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
  });

  const updateScheduleNextRun = SqlSchema.void({
    Request: UpdateAutomationScheduleNextRunInput,
    execute: ({ automationId, nextRunAt, updatedAt }) =>
      sql`
        UPDATE automation_schedules
        SET next_run_at = ${nextRunAt}, lease_until = NULL, updated_at = ${updatedAt}
        WHERE automation_id = ${automationId}
          AND deleted_at IS NULL
      `,
  });

  const pauseSchedule = SqlSchema.void({
    Request: PauseAutomationScheduleInput,
    execute: ({ automationId, pausedAt, updatedAt }) =>
      sql`
        UPDATE automation_schedules
        SET paused_at = ${pausedAt}, lease_until = NULL, updated_at = ${updatedAt}
        WHERE automation_id = ${automationId}
          AND deleted_at IS NULL
      `,
  });

  const resumeSchedule = SqlSchema.void({
    Request: ResumeAutomationScheduleInput,
    execute: ({ automationId, nextRunAt, updatedAt }) =>
      sql`
        UPDATE automation_schedules
        SET paused_at = NULL, next_run_at = ${nextRunAt}, lease_until = NULL, updated_at = ${updatedAt}
        WHERE automation_id = ${automationId}
          AND deleted_at IS NULL
      `,
  });

  const deleteSchedule = SqlSchema.void({
    Request: DeleteAutomationScheduleInput,
    execute: ({ automationId, deletedAt, updatedAt }) =>
      sql`
        UPDATE automation_schedules
        SET deleted_at = ${deletedAt}, lease_until = NULL, updated_at = ${updatedAt}
        WHERE automation_id = ${automationId}
      `,
  });

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
          status,
          started_at
        )
        VALUES (
          ${input.runId},
          ${input.automationId},
          ${input.threadId},
          ${input.messageId},
          ${input.commandId},
          'started',
          ${input.startedAt}
        )
      `,
  });

  const markRunFinished = SqlSchema.void({
    Request: RecordAutomationRunFinishedInput,
    execute: ({ runId, finishedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'finished', finished_at = ${finishedAt}
        WHERE run_id = ${runId}
      `,
  });

  const markRunFailed = SqlSchema.void({
    Request: RecordAutomationRunFailedInput,
    execute: ({ runId, finishedAt, errorMessage }) =>
      sql`
        UPDATE automation_runs
        SET status = 'failed', finished_at = ${finishedAt}, error_message = ${errorMessage}
        WHERE run_id = ${runId}
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
          status,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          error_message AS "errorMessage"
        FROM automation_runs
        WHERE automation_id = ${automationId}
        ORDER BY started_at DESC, run_id DESC
        LIMIT ${limit}
      `,
  });

  const create: AutomationScheduleRepositoryShape["create"] = (input) =>
    createSchedule(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.create:query")(cause),
      ),
    );

  const getById: AutomationScheduleRepositoryShape["getById"] = (input) =>
    getScheduleById(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.getById:query")(cause),
      ),
    );

  const listByThread: AutomationScheduleRepositoryShape["listByThread"] = (input) =>
    listSchedulesByThread(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.listByThread:query")(cause),
      ),
    );

  const claimDue: AutomationScheduleRepositoryShape["claimDue"] = (input) =>
    claimDueSchedules(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.claimDue:query")(cause),
      ),
    );

  const update: AutomationScheduleRepositoryShape["update"] = (input) =>
    updateSchedule(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.update:query")(cause),
      ),
    );

  const updateNextRun: AutomationScheduleRepositoryShape["updateNextRun"] = (input) =>
    updateScheduleNextRun(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.updateNextRun:query")(cause),
      ),
    );

  const pause: AutomationScheduleRepositoryShape["pause"] = (input) =>
    pauseSchedule(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.pause:query")(cause),
      ),
    );

  const resume: AutomationScheduleRepositoryShape["resume"] = (input) =>
    resumeSchedule(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.resume:query")(cause),
      ),
    );

  const deleteScheduleById: AutomationScheduleRepositoryShape["delete"] = (input) =>
    deleteSchedule(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.delete:query")(cause),
      ),
    );

  const recordRunStarted: AutomationScheduleRepositoryShape["recordRunStarted"] = (input) =>
    insertRunStarted(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationScheduleRepository.recordRunStarted:query")),
    );

  const recordRunFinished: AutomationScheduleRepositoryShape["recordRunFinished"] = (input) =>
    markRunFinished(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationScheduleRepository.recordRunFinished:query"),
      ),
    );

  const recordRunFailed: AutomationScheduleRepositoryShape["recordRunFailed"] = (input) =>
    markRunFailed(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationScheduleRepository.recordRunFailed:query")),
    );

  const listRuns: AutomationScheduleRepositoryShape["listRuns"] = (input) =>
    listRunRows(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.listRuns:query")(cause),
      ),
    );

  return {
    create,
    getById,
    listByThread,
    claimDue,
    update,
    updateNextRun,
    pause,
    resume,
    delete: deleteScheduleById,
    recordRunStarted,
    recordRunFinished,
    recordRunFailed,
    listRuns,
  } satisfies AutomationScheduleRepositoryShape;
});

export const AutomationScheduleRepositoryLive = Layer.effect(
  AutomationScheduleRepository,
  makeAutomationScheduleRepository,
);
