import { AutomationSchedule, BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError, AutomationScheduleNotFoundError } from "../Errors.ts";
import { makeAutomationRunQueries } from "./AutomationScheduleRepository.runs.ts";
import {
  AutomationScheduleRepository,
  type AutomationScheduleRepositoryShape,
  ClaimDueAutomationSchedulesInput,
  CompleteAutomationScheduleInput,
  CreateAutomationScheduleInput,
  DeleteAutomationScheduleInput,
  GetAutomationScheduleInput,
  ListAutomationSchedulesByProjectInput,
  PauseAutomationScheduleInput,
  ResumeAutomationScheduleInput,
  UpdateAutomationScheduleInput,
  UpdateAutomationScheduleNextRunInput,
} from "../Services/AutomationScheduleRepository.ts";

const timestampNow = () => new Date().toISOString();

const makeAutomationScheduleRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runQueries = yield* makeAutomationRunQueries;

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
          schedule_kind,
          schedule_label,
          cron_expression,
          timezone,
          run_at,
          next_run_at,
          paused_at,
          completed_at,
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
          ${input.scheduleKind},
          ${input.scheduleLabel},
          ${input.cronExpression},
          ${input.timezone},
          ${input.runAt},
          ${input.nextRunAt},
          NULL,
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
          schedule_kind AS "scheduleKind",
          schedule_label AS "scheduleLabel",
          cron_expression AS "cronExpression",
          timezone,
          run_at AS "runAt",
          next_run_at AS "nextRunAt",
          paused_at AS "pausedAt",
          completed_at AS "completedAt",
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
          schedule_kind AS "scheduleKind",
          schedule_label AS "scheduleLabel",
          cron_expression AS "cronExpression",
          timezone,
          run_at AS "runAt",
          next_run_at AS "nextRunAt",
          paused_at AS "pausedAt",
          completed_at AS "completedAt",
          deleted_at AS "deletedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_schedules
        WHERE automation_id = ${automationId}
      `,
  });

  const listSchedulesByProject = SqlSchema.findAll({
    Request: ListAutomationSchedulesByProjectInput,
    Result: AutomationSchedule,
    execute: ({ projectId }) =>
      sql`
        SELECT
          automation_id AS "automationId",
          project_id AS "projectId",
          target_thread_id AS "targetThreadId",
          title,
          prompt,
          schedule_kind AS "scheduleKind",
          schedule_label AS "scheduleLabel",
          cron_expression AS "cronExpression",
          timezone,
          run_at AS "runAt",
          next_run_at AS "nextRunAt",
          paused_at AS "pausedAt",
          completed_at AS "completedAt",
          deleted_at AS "deletedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_schedules
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, automation_id ASC
      `,
  });

  const listAllSchedules = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: AutomationSchedule,
    execute: () =>
      sql`
        SELECT
          automation_id AS "automationId",
          COALESCE(
            automation_schedules.project_id,
            (
              SELECT projection_threads.project_id
              FROM projection_threads
              WHERE projection_threads.thread_id = automation_schedules.target_thread_id
              LIMIT 1
            ),
            ${BUILT_IN_CHATS_PROJECT_ID}
          ) AS "projectId",
          target_thread_id AS "targetThreadId",
          title,
          prompt,
          schedule_kind AS "scheduleKind",
          schedule_label AS "scheduleLabel",
          cron_expression AS "cronExpression",
          timezone,
          run_at AS "runAt",
          next_run_at AS "nextRunAt",
          paused_at AS "pausedAt",
          completed_at AS "completedAt",
          deleted_at AS "deletedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_schedules
        WHERE deleted_at IS NULL
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
            AND completed_at IS NULL
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
          schedule_kind AS "scheduleKind",
          schedule_label AS "scheduleLabel",
          cron_expression AS "cronExpression",
          timezone,
          run_at AS "runAt",
          next_run_at AS "nextRunAt",
          paused_at AS "pausedAt",
          completed_at AS "completedAt",
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
          schedule_kind = COALESCE(${input.scheduleKind ?? null}, schedule_kind),
          schedule_label = COALESCE(${input.scheduleLabel ?? null}, schedule_label),
          cron_expression = COALESCE(${input.cronExpression ?? null}, cron_expression),
          timezone = COALESCE(${input.timezone ?? null}, timezone),
          run_at = CASE WHEN ${input.runAt === undefined ? 0 : 1} = 1 THEN ${input.runAt ?? null} ELSE run_at END,
          next_run_at = COALESCE(${input.nextRunAt ?? null}, next_run_at),
          completed_at = CASE WHEN ${input.nextRunAt === undefined ? 1 : 0} = 1 THEN completed_at ELSE NULL END,
          updated_at = ${input.updatedAt}
        WHERE automation_id = ${input.automationId}
          AND deleted_at IS NULL
        RETURNING
          automation_id AS "automationId",
          project_id AS "projectId",
          target_thread_id AS "targetThreadId",
          title,
          prompt,
          schedule_kind AS "scheduleKind",
          schedule_label AS "scheduleLabel",
          cron_expression AS "cronExpression",
          timezone,
          run_at AS "runAt",
          next_run_at AS "nextRunAt",
          paused_at AS "pausedAt",
          completed_at AS "completedAt",
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
        SET next_run_at = ${nextRunAt}, completed_at = NULL, lease_until = NULL, updated_at = ${updatedAt}
        WHERE automation_id = ${automationId}
          AND deleted_at IS NULL
      `,
  });

  const pauseSchedule = (input: typeof PauseAutomationScheduleInput.Type) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly automationId: string }>`
        UPDATE automation_schedules
        SET paused_at = ${input.pausedAt}, lease_until = NULL, updated_at = ${input.updatedAt}
        WHERE automation_id = ${input.automationId}
          AND deleted_at IS NULL
          AND paused_at IS NULL
          AND completed_at IS NULL
        RETURNING automation_id AS "automationId"
      `;
      if (rows.length === 0) {
        return yield* new AutomationScheduleNotFoundError({ automationId: input.automationId });
      }
    });

  const resumeSchedule = (input: typeof ResumeAutomationScheduleInput.Type) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly automationId: string }>`
        UPDATE automation_schedules
        SET paused_at = NULL, completed_at = NULL, next_run_at = ${input.nextRunAt}, lease_until = NULL, updated_at = ${input.updatedAt}
        WHERE automation_id = ${input.automationId}
          AND deleted_at IS NULL
          AND paused_at IS NOT NULL
          AND completed_at IS NULL
        RETURNING automation_id AS "automationId"
      `;
      if (rows.length === 0) {
        return yield* new AutomationScheduleNotFoundError({ automationId: input.automationId });
      }
    });

  const completeSchedule = SqlSchema.void({
    Request: CompleteAutomationScheduleInput,
    execute: ({ automationId, completedAt, updatedAt }) =>
      sql`
        UPDATE automation_schedules
        SET completed_at = ${completedAt}, next_run_at = NULL, lease_until = NULL, updated_at = ${updatedAt}
        WHERE automation_id = ${automationId}
          AND deleted_at IS NULL
      `,
  });

  const deleteSchedule = (input: typeof DeleteAutomationScheduleInput.Type) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly automationId: string }>`
        UPDATE automation_schedules
        SET deleted_at = ${input.deletedAt}, lease_until = NULL, updated_at = ${input.updatedAt}
        WHERE automation_id = ${input.automationId}
          AND deleted_at IS NULL
        RETURNING automation_id AS "automationId"
      `;
      if (rows.length === 0) {
        return yield* new AutomationScheduleNotFoundError({ automationId: input.automationId });
      }
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

  const listByProject: AutomationScheduleRepositoryShape["listByProject"] = (input) =>
    listSchedulesByProject(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.listByProject:query")(cause),
      ),
    );

  const listAll: AutomationScheduleRepositoryShape["listAll"] = () =>
    listAllSchedules({}).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.listAll:query")(cause),
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
        Schema.is(AutomationScheduleNotFoundError)(cause)
          ? cause
          : toPersistenceSqlError("AutomationScheduleRepository.pause:query")(cause),
      ),
    );

  const resume: AutomationScheduleRepositoryShape["resume"] = (input) =>
    resumeSchedule(input).pipe(
      Effect.mapError((cause) =>
        Schema.is(AutomationScheduleNotFoundError)(cause)
          ? cause
          : toPersistenceSqlError("AutomationScheduleRepository.resume:query")(cause),
      ),
    );

  const complete: AutomationScheduleRepositoryShape["complete"] = (input) =>
    completeSchedule(input).pipe(
      Effect.mapError((cause) =>
        toPersistenceSqlError("AutomationScheduleRepository.complete:query")(cause),
      ),
    );

  const deleteScheduleById: AutomationScheduleRepositoryShape["delete"] = (input) =>
    deleteSchedule(input).pipe(
      Effect.mapError((cause) =>
        Schema.is(AutomationScheduleNotFoundError)(cause)
          ? cause
          : toPersistenceSqlError("AutomationScheduleRepository.delete:query")(cause),
      ),
    );

  return {
    create,
    getById,
    listByProject,
    listAll,
    claimDue,
    update,
    updateNextRun,
    pause,
    resume,
    complete,
    delete: deleteScheduleById,
    ...runQueries,
  } satisfies AutomationScheduleRepositoryShape;
});

export const AutomationScheduleRepositoryLive = Layer.effect(
  AutomationScheduleRepository,
  makeAutomationScheduleRepository,
);
