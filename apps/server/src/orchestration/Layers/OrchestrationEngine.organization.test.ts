import { CommandId, ProjectId, ThreadId, type OrchestrationCommand } from "@bigbud/contracts";
import { ThreadOrganization } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { threadOrganizationJsonSql } from "../../persistence/Layers/ProjectionThreads.organization.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const projectId = ProjectId.makeUnsafe("project-organization");
const threadId = ThreadId.makeUnsafe("thread-organization");
const createdAt = "2026-10-30T00:00:00.000Z";

type OrganizationCommand = Extract<
  OrchestrationCommand,
  { type: "thread.organization.move" | "thread.organization.snooze" }
>;
type OrganizationCommandBody = OrganizationCommand extends infer C
  ? C extends OrganizationCommand
    ? Omit<C, "commandId" | "threadId" | "createdAt">
    : never
  : never;

function command(id: string, body: OrganizationCommandBody): OrchestrationCommand {
  return {
    ...body,
    commandId: CommandId.makeUnsafe(id),
    threadId,
    createdAt,
  } as OrchestrationCommand;
}

type Runtime = ReturnType<typeof createRuntime>;

const decodeOrganization = Schema.decodeUnknownSync(Schema.fromJsonString(ThreadOrganization));

/** Reads the persisted projection, the source every hydration query selects from. */
const persistedOrganization = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly organization: string }>`
        SELECT ${threadOrganizationJsonSql(sql)} AS "organization"
        FROM projection_threads WHERE thread_id = ${threadId}
      `;
      return decodeOrganization(rows[0]?.organization);
    }),
  );

describe("OrchestrationEngine thread organization", () => {
  it("persists moves and snoozes across restart and fences stale revisions", () =>
    withDatabase("bigbud-organization-restart-", async (dbPath) => {
      const first = createRuntime(dbPath);
      const firstEngine = await engineFor(first);
      for (const setup of createCommands(projectId, [threadId])) {
        await first.runPromise(firstEngine.dispatch(setup));
      }
      expect(await persistedOrganization(first)).toEqual({
        state: "present",
        revision: 0,
        changedAt: null,
        activityAt: null,
        ageProvenance: "known",
        snooze: null,
      });

      await first.runPromise(
        firstEngine.dispatch(
          command("cmd-move-done", { type: "thread.organization.move", state: "done" }),
        ),
      );
      const repeated = await first.runPromise(
        firstEngine.dispatch(
          command("cmd-move-done-again", { type: "thread.organization.move", state: "done" }),
        ),
      );
      const snoozed = await first.runPromise(
        firstEngine.dispatch(
          command("cmd-snooze", { type: "thread.organization.snooze", durationMinutes: 30 }),
        ),
      );
      expect(repeated.sequence).toBeLessThan(snoozed.sequence);
      await first.dispose();

      const second = createRuntime(dbPath);
      const secondEngine = await engineFor(second);
      const restored = await persistedOrganization(second);
      // The repeated deliberate move renews its override and therefore advances revision too.
      expect(restored).toMatchObject({ state: "later", revision: 3, snooze: { id: "cmd-snooze" } });
      const changedAt = Date.parse(restored!.changedAt!);
      expect(Date.parse(restored!.snooze!.until) - changedAt).toBe(30 * 60_000);

      await expect(
        second.runPromise(
          secondEngine.dispatch(
            command("cmd-stale", {
              type: "thread.organization.move",
              state: "present",
              expectedRevision: 1,
            }),
          ),
        ),
      ).rejects.toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      await second.runPromise(
        secondEngine.dispatch(
          command("cmd-move-later", {
            type: "thread.organization.move",
            state: "later",
            expectedRevision: 3,
          }),
        ),
      );
      expect(await persistedOrganization(second)).toMatchObject({
        state: "later",
        revision: 4,
        snooze: null,
      });
      const readModel = await second.runPromise(secondEngine.getReadModel());
      expect(
        readModel.threads.find((thread) => thread.id === threadId)?.organization,
      ).toMatchObject({ state: "later", revision: 4 });
      await second.dispose();
    }));

  it("cancels a snooze on archive and returns unarchived threads to Present", () =>
    withDatabase("bigbud-organization-archive-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      const engine = await engineFor(runtime);
      for (const setup of createCommands(projectId, [threadId])) {
        await runtime.runPromise(engine.dispatch(setup));
      }
      const dispatch = (next: OrchestrationCommand) => runtime.runPromise(engine.dispatch(next));
      await dispatch(
        command("cmd-snooze", { type: "thread.organization.snooze", durationMinutes: 2 }),
      );
      await dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("cmd-archive"),
        threadId,
      });
      expect(await persistedOrganization(runtime)).toMatchObject({ state: "later", snooze: null });
      await expect(
        dispatch(command("cmd-move-archived", { type: "thread.organization.move", state: "done" })),
      ).rejects.toMatchObject({ _tag: "OrchestrationCommandInvariantError" });

      await dispatch({
        type: "thread.unarchive",
        commandId: CommandId.makeUnsafe("cmd-unarchive"),
        threadId,
      });
      expect(await persistedOrganization(runtime)).toMatchObject({
        state: "present",
        revision: 3,
        snooze: null,
      });
      await runtime.dispose();
    }));
});
