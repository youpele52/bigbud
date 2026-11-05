import { makeReservedQueuedPromptFlushCommand } from "../QueuedPromptFlush.control.ts";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
} from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";
import { makeQueuedPromptFlushCommand } from "../QueuedPromptFlush.logic.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

const at = "2026-10-28T12:00:00.000Z";
const projectId = ProjectId.makeUnsafe("queue-attempt-project");
const threadId = ThreadId.makeUnsafe("queue-attempt-thread");
const promptId = MessageId.makeUnsafe("queued");
const queue: OrchestrationCommand = {
  type: "thread.message.submit",
  commandId: CommandId.makeUnsafe("queue"),
  threadId,
  message: { messageId: promptId, text: "Please continue" },
  delivery: "queue",
  createdAt: at,
};
const approval = (resolved: boolean): OrchestrationCommand => ({
  type: "thread.activity.append",
  commandId: CommandId.makeUnsafe(`approval-${resolved}`),
  threadId,
  activity: {
    id: EventId.makeUnsafe(`approval-${resolved}`),
    kind: resolved ? "approval.resolved" : "approval.requested",
    tone: "info",
    summary: "Approval",
    payload: { requestId: "approval" },
    turnId: null,
    createdAt: at,
  },
  createdAt: at,
});

describe("durable queue attempts", () => {
  it("records a known blocked attempt, retries after state settlement, and replays acceptance once", () =>
    withDatabase("queue-attempt-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const engine = await engineFor(runtime);
        for (const cmd of [...createCommands(projectId, [threadId]), queue])
          await runtime.runPromise(engine.dispatch(cmd));
        const snapshot = await runtime.runPromise(engine.getReadModel());
        const attempt = makeQueuedPromptFlushCommand({
          threadId,
          readModel: snapshot,
          createdAt: at,
        })!;
        await runtime.runPromise(engine.dispatch(approval(false)));
        await expect(runtime.runPromise(engine.dispatch(attempt))).rejects.toThrow(
          "waiting for a response",
        );
        expect(
          await runtime.runPromise(engine.getCommandOutcome!(attempt.commandId)),
        ).toMatchObject({ status: "rejected", reason: "queue_waiting_for_user" });
        await expect(runtime.runPromise(engine.dispatch(attempt))).rejects.toThrow(
          "waiting for a response",
        );
        await runtime.runPromise(engine.dispatch(approval(true)));
        await vi.waitFor(async () =>
          expect(
            (await runtime.runPromise(engine.getReadModel())).threads[0]?.queuedPrompts,
          ).toEqual([]),
        );
        const events = Array.from(
          await runtime.runPromise(Stream.runCollect(engine.readEvents(0))),
        );
        const flush = events.find((event) => event.type === "thread.queued-prompts-flushed")!;
        expect(flush.commandId).not.toBe(attempt.commandId);
        const outcome = await runtime.runPromise(engine.getCommandOutcome!(flush.commandId!));
        expect(outcome.status).toBe("accepted");
        expect(
          events.filter(
            (event) => event.type === "thread.message-sent" && event.payload.role === "user",
          ),
        ).toHaveLength(1);
      } finally {
        await runtime.dispose();
      }
      const restarted = createRuntime(dbPath);
      try {
        const engine = await engineFor(restarted);
        const events = Array.from(
          await restarted.runPromise(Stream.runCollect(engine.readEvents(0))),
        );
        expect(
          events.filter(
            (event) => event.type === "thread.message-sent" && event.payload.role === "user",
          ),
        ).toHaveLength(1);
      } finally {
        await restarted.dispose();
      }
    }));

  it("recovers an eligible queue despite a legacy conflicting claim without deleting the claim", () =>
    withDatabase("queue-legacy-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      let legacyId = "";
      try {
        const engine = await engineFor(runtime);
        for (const cmd of [...createCommands(projectId, [threadId]), queue])
          await runtime.runPromise(engine.dispatch(cmd));
        const attempt = makeQueuedPromptFlushCommand({
          threadId,
          readModel: await runtime.runPromise(engine.getReadModel()),
          createdAt: at,
        })!;
        legacyId = attempt.commandId
          .replace("queue-flush:v2:", "queue-flush:")
          .replace(/:\d+$/, "");
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO orchestration_command_receipt_claims (command_id, payload_digest_version, payload_digest, claimed_at) VALUES (${legacyId}, 'orchestration-command-payload/v1', 'old-timestamp-digest', ${at})`;
          }),
        );
      } finally {
        await runtime.dispose();
      }
      const restarted = createRuntime(dbPath);
      try {
        const engine = await engineFor(restarted);
        await vi.waitFor(async () =>
          expect(
            (await restarted.runPromise(engine.getReadModel())).threads[0]?.queuedPrompts,
          ).toEqual([]),
        );
        const events = Array.from(
          await restarted.runPromise(Stream.runCollect(engine.readEvents(0))),
        );
        expect(
          events.filter((event) => event.type === "thread.queued-prompts-flushed"),
        ).toHaveLength(1);
        const claims = await restarted.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT payload_digest FROM orchestration_command_receipt_claims WHERE command_id = ${legacyId}`;
          }),
        );
        expect(claims).toEqual([{ payload_digest: "old-timestamp-digest" }]);
      } finally {
        await restarted.dispose();
      }
    }));
  it("deduplicates concurrent releases and reconciles accepted receipt after queue removal", () =>
    withDatabase("queue-concurrent-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      const release: OrchestrationCommand = {
        type: "thread.queued-prompt.flush",
        commandId: CommandId.makeUnsafe("manual-release"),
        threadId,
        messageIds: [promptId],
        messageId: MessageId.makeUnsafe("manual-message"),
        userRelease: true,
        expectedTurnId: null,
        expectedSessionEpoch: 0,
        promptVersions: [{ id: promptId, createdAt: at, alreadySent: false }],
        createdAt: at,
      };
      let sequence = 0;
      try {
        const engine = await engineFor(runtime);
        for (const cmd of [...createCommands(projectId, [threadId]), queue])
          await runtime.runPromise(engine.dispatch(cmd));
        const [first, duplicate] = await Promise.all([
          runtime.runPromise(engine.dispatch(release)),
          runtime.runPromise(engine.dispatch(release)),
        ]);
        expect(duplicate).toEqual(first);
        sequence = first.sequence;
        await expect(
          runtime.runPromise(
            engine.dispatch({ ...release, commandId: CommandId.makeUnsafe("second-client") }),
          ),
        ).rejects.toMatchObject({ code: "queue_stale_selection" });
        const events = Array.from(
          await runtime.runPromise(Stream.runCollect(engine.readEvents(0))),
        );
        expect(
          events.filter((event) => event.type === "thread.queued-prompts-flushed"),
        ).toHaveLength(1);
      } finally {
        await runtime.dispose();
      }
      const restarted = createRuntime(dbPath);
      try {
        const engine = await engineFor(restarted);
        expect(await restarted.runPromise(engine.dispatch(release))).toEqual({ sequence });
        expect(
          await restarted.runPromise(engine.getCommandOutcome!(release.commandId)),
        ).toMatchObject({ status: "accepted", resultSequence: sequence });
      } finally {
        await restarted.dispose();
      }
    }));
  it("recovers an owned reservation after a non-session gate rejects its earlier attempt", () =>
    withDatabase("queue-owned-race-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const engine = await engineFor(runtime);
        const operation = {
          operationId: CommandId.makeUnsafe("owned"),
          action: "interrupt-and-continue" as const,
          strategy: "interrupt-continue" as const,
          state: "waiting-for-settlement" as const,
          reservedPromptIds: [promptId],
          sessionEpoch: 0,
          expectedTurnId: null,
          requestedAt: at,
          updatedAt: at,
        };
        for (const cmd of [...createCommands(projectId, [threadId]), queue])
          await runtime.runPromise(engine.dispatch(cmd));
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.turn-control.set",
            commandId: CommandId.makeUnsafe("reserve"),
            threadId,
            operation,
            createdAt: at,
          }),
        );
        const firstState = await runtime.runPromise(engine.getReadModel());
        const first = makeReservedQueuedPromptFlushCommand({
          thread: firstState.threads[0]!,
          operation,
          revision: firstState.snapshotSequence,
        })!;
        await runtime.runPromise(engine.dispatch(approval(false)));
        await expect(runtime.runPromise(engine.dispatch(first))).rejects.toMatchObject({
          code: "queue_waiting_for_user",
        });
        await runtime.runPromise(engine.dispatch(approval(true)));
        const nextState = await runtime.runPromise(engine.getReadModel());
        expect(nextState.threads[0]!.session).toEqual(firstState.threads[0]!.session);
        expect(nextState.threads[0]!.pendingTurnControlOperation).toEqual(operation);
        const next = makeReservedQueuedPromptFlushCommand({
          thread: nextState.threads[0]!,
          operation,
          revision: nextState.snapshotSequence,
        })!;
        expect(next.commandId).not.toBe(first.commandId);
        expect(next.messageId).toBe(first.messageId);
        await runtime.runPromise(engine.dispatch(next));
        expect((await runtime.runPromise(engine.getReadModel())).threads[0]?.queuedPrompts).toEqual(
          [],
        );
        expect(await runtime.runPromise(engine.getCommandOutcome!(first.commandId))).toMatchObject({
          status: "rejected",
          reason: "queue_waiting_for_user",
        });
        expect(await runtime.runPromise(engine.getCommandOutcome!(next.commandId))).toMatchObject({
          status: "accepted",
        });
      } finally {
        await runtime.dispose();
      }
    }));
});
