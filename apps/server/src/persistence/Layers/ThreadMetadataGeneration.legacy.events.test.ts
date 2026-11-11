import { CommandId, EventId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "../../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { makeLegacyMetadataEvidenceReader } from "./ThreadMetadataGeneration.legacy.ts";

const threadId = ThreadId.makeUnsafe("legacy-events");
const at = "2026-11-09T10:00:00.000Z";
const commandAt = "2026-11-09T10:00:01.000Z";
const activityCommand = (suffix: string, kind = "text-generation.model-succeeded") => ({
  type: "thread.activity.append" as const,
  commandId: CommandId.makeUnsafe(`provider:event:${suffix}:${crypto.randomUUID()}`),
  threadId,
  createdAt: commandAt,
  activity: {
    id: EventId.makeUnsafe(`text-generation-model:${suffix}`),
    tone: "info" as const,
    kind,
    summary: "Verified metadata evidence",
    payload: { provider: "codex", model: "verified" },
    turnId: null,
    createdAt: at,
  },
});
const initialize = async (runtime: ReturnType<typeof createRuntime>) => {
  const engine = await engineFor(runtime);
  for (const command of createCommands(ProjectId.makeUnsafe("legacy-events-project"), [threadId]))
    await runtime.runPromise(engine.dispatch(command));
  return engine;
};

it("recovers exact provider command identity and outer timestamp beyond the activity tail after restart", () =>
  withDatabase("bigbud-legacy-event-restart-", async (dbPath) => {
    const first = createRuntime(dbPath);
    const command = activityCommand("verified");
    let sequence: number;
    try {
      const engine = await initialize(first);
      sequence = (await first.runPromise(engine.dispatch(command))).sequence;
      for (let index = 0; index < 501; index += 1) {
        const progress = activityCommand(`progress-${index}`, "runtime.progress");
        await first.runPromise(
          engine.dispatch({
            ...progress,
            activity: { ...progress.activity, createdAt: commandAt },
          }),
        );
      }
      const thread = (await first.runPromise(engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.activities).toHaveLength(500);
      expect(thread?.activities.some((activity) => activity.id === command.activity.id)).toBe(
        false,
      );
      const read = await first.runPromise(makeLegacyMetadataEvidenceReader());
      expect((await first.runPromise(read({ threadId }))).evidence).toEqual([
        expect.objectContaining({ commandId: command.commandId, witness: "accepted", sequence }),
      ]);
    } finally {
      await first.dispose();
    }
    const second = createRuntime(dbPath);
    try {
      await engineFor(second);
      const read = await second.runPromise(makeLegacyMetadataEvidenceReader());
      expect((await second.runPromise(read({ threadId }))).evidence).toEqual([
        expect.objectContaining({
          commandId: command.commandId,
          witness: "accepted",
          sequence: sequence!,
          activity: expect.objectContaining({ id: command.activity.id, createdAt: at }),
        }),
      ]);
    } finally {
      await second.dispose();
    }
  }));

it("never upgrades mismatched event identity, malformed payloads or unknown random commands", () =>
  withDatabase("bigbud-legacy-event-fences-", async (dbPath) => {
    const runtime = createRuntime(dbPath);
    try {
      const engine = await initialize(runtime);
      for (const fault of [
        "aggregate",
        "stream",
        "type",
        "activity",
        "thread",
        "json",
        "missing",
      ] as const) {
        const command = activityCommand(fault);
        const { sequence } = await runtime.runPromise(engine.dispatch(command));
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            if (fault === "aggregate")
              yield* sql`UPDATE orchestration_events SET aggregate_kind = 'project' WHERE sequence = ${sequence}`;
            else if (fault === "stream")
              yield* sql`UPDATE orchestration_events SET stream_id = 'another-thread' WHERE sequence = ${sequence}`;
            else if (fault === "type")
              yield* sql`UPDATE orchestration_events SET event_type = 'thread.meta-updated' WHERE sequence = ${sequence}`;
            else if (fault === "missing")
              yield* sql`DELETE FROM orchestration_events WHERE sequence = ${sequence}`;
            else {
              const payload =
                fault === "json"
                  ? "{broken"
                  : JSON.stringify({
                      threadId: fault === "thread" ? "another-thread" : threadId,
                      activity: {
                        ...command.activity,
                        id: fault === "activity" ? "another-activity" : command.activity.id,
                      },
                    });
              yield* sql`UPDATE orchestration_events SET payload_json = ${payload} WHERE sequence = ${sequence}`;
            }
          }),
        );
      }
      const read = await runtime.runPromise(makeLegacyMetadataEvidenceReader());
      const { evidence } = await runtime.runPromise(read({ threadId }));
      expect(evidence.filter((item) => item.activity !== null)).toHaveLength(7);
      expect(evidence.every((item) => item.witness === "unknown")).toBe(true);
      expect(
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT status FROM orchestration_command_receipts WHERE aggregate_id = ${threadId} AND command_id LIKE 'provider:%'`;
          }),
        ),
      ).toEqual(Array.from({ length: 7 }, () => ({ status: "accepted" })));
    } finally {
      await runtime.dispose();
    }
  }));

it("retains event-identified orphan receipts as unknown without returning duplicate evidence", () =>
  withDatabase("bigbud-legacy-event-orphan-", async (dbPath) => {
    const runtime = createRuntime(dbPath);
    try {
      const engine = await initialize(runtime);
      const retainedBase = activityCommand("retained");
      const retained = { ...retainedBase, activity: { ...retainedBase.activity, sequence: 9_000 } };
      const orphan = activityCommand("orphan");
      await runtime.runPromise(engine.dispatch(retained));
      await runtime.runPromise(engine.dispatch(orphan));
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = ${orphan.activity.id}`;
        }),
      );
      const read = await runtime.runPromise(makeLegacyMetadataEvidenceReader());
      expect((await runtime.runPromise(read({ threadId }))).evidence).toEqual([
        expect.objectContaining({ commandId: retained.commandId, witness: "accepted" }),
        expect.objectContaining({
          commandId: orphan.commandId,
          witness: "unknown",
          activity: null,
        }),
      ]);
    } finally {
      await runtime.dispose();
    }
  }));
