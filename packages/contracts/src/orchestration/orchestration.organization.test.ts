import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import { ClientOrchestrationCommand } from "./orchestration.commands";
import { OrchestrationEvent } from "./orchestration.events";
import { DEFAULT_THREAD_ORGANIZATION } from "./orchestration.organization";
import { OrchestrationThread } from "./orchestration.thread";

const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);

const at = "2026-10-30T10:00:00.000Z";

const legacyThread = {
  id: "thread-1",
  projectId: "project-1",
  title: "Thread",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
  messages: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const snoozeCommand = (durationMinutes: number) => ({
  type: "thread.organization.snooze",
  commandId: "command-1",
  threadId: "thread-1",
  durationMinutes,
  createdAt: at,
});

it.effect("decodes thread snapshots written before organization existed as Present", () =>
  Effect.gen(function* () {
    const thread = yield* decodeThread(legacyThread);
    assert.deepStrictEqual(thread.organization, DEFAULT_THREAD_ORGANIZATION);
  }),
);

it.effect("accepts snooze durations from 2 minutes through 24 hours inclusive", () =>
  Effect.gen(function* () {
    for (const minutes of [2, 60, 1440]) {
      const command = yield* decodeClientCommand(snoozeCommand(minutes));
      assert.strictEqual(command.type, "thread.organization.snooze");
    }
    for (const minutes of [0, 1, 1441, 2.5]) {
      const exit = yield* Effect.exit(decodeClientCommand(snoozeCommand(minutes)));
      assert.ok(Exit.isFailure(exit), `${minutes} minutes should be rejected`);
    }
  }),
);

it.effect("accepts the four organization states only", () =>
  Effect.gen(function* () {
    for (const state of ["present", "needs-you", "later", "done"]) {
      yield* decodeClientCommand({
        type: "thread.organization.move",
        commandId: "command-1",
        threadId: "thread-1",
        state,
        createdAt: at,
      });
    }
    const exit = yield* Effect.exit(
      decodeClientCommand({
        type: "thread.organization.move",
        commandId: "command-1",
        threadId: "thread-1",
        state: "archived",
        createdAt: at,
      }),
    );
    assert.ok(Exit.isFailure(exit));
  }),
);

it.effect("decodes an organization update event", () =>
  Effect.gen(function* () {
    const event = yield* decodeEvent({
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: at,
      commandId: "command-1",
      causationEventId: null,
      correlationId: "command-1",
      metadata: {},
      type: "thread.organization-updated",
      payload: {
        threadId: "thread-1",
        organization: {
          state: "later",
          revision: 1,
          changedAt: at,
          snooze: { id: "command-1", until: "2026-10-30T10:30:00.000Z" },
        },
        reason: "snooze",
      },
    });
    assert.strictEqual(event.type, "thread.organization-updated");
  }),
);
