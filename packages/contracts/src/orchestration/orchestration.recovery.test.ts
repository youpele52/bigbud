import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { OrchestrationEvent } from "./orchestration.events";
import { ClientOrchestrationCommand, OrchestrationCommand } from "./orchestration.commands";
import { MessageOriginSegment } from "./orchestration.messageOrigin";
import { ThreadRecovery } from "./orchestration.recovery";
import { OrchestrationThread } from "./orchestration.thread";
import { ToolActivityPayload } from "./orchestration.toolActivity";

const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeClientCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeToolPayload = Schema.decodeUnknownEffect(ToolActivityPayload);
const decodeOrigin = Schema.decodeUnknownEffect(MessageOriginSegment);

const at = "2026-10-22T10:00:00.000Z";

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

const recovery = {
  status: "awaiting-user",
  reason: "tool-in-flight",
  toolSummary: "Run tests",
  attempt: 0,
  provider: "claudeAgent",
  messageId: "message-1",
  updatedAt: at,
};

it.effect("decodes thread snapshots written before recovery existed", () =>
  Effect.gen(function* () {
    const thread = yield* decodeThread(legacyThread);
    assert.strictEqual(thread.recovery, null);
  }),
);

it.effect("decodes a thread recovery notice", () =>
  Effect.gen(function* () {
    const thread = yield* decodeThread({ ...legacyThread, recovery });
    assert.deepStrictEqual(
      thread.recovery,
      yield* Schema.decodeUnknownEffect(ThreadRecovery)(recovery),
    );
  }),
);

it.effect("decodes thread.recovery-updated events, including a cleared notice", () =>
  Effect.gen(function* () {
    const base = {
      sequence: 1,
      eventId: "event-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.recovery-updated",
    };
    const set = yield* decodeEvent({
      ...base,
      payload: { threadId: "thread-1", recovery, createdAt: at },
    });
    assert.strictEqual(set.type, "thread.recovery-updated");
    const cleared = yield* decodeEvent({
      ...base,
      payload: {
        threadId: "thread-1",
        recovery: null,
        messageId: "message-1",
        resolvedAction: "dismiss",
        createdAt: at,
      },
    });
    assert.strictEqual(
      cleared.type === "thread.recovery-updated" && cleared.payload.recovery,
      null,
    );
  }),
);

it.effect("decodes the client resolve command and the internal set command", () =>
  Effect.gen(function* () {
    const resolve = yield* decodeClientCommand({
      type: "thread.recovery.resolve",
      commandId: "command-1",
      threadId: "thread-1",
      action: "continue",
      createdAt: at,
    });
    assert.strictEqual(resolve.type, "thread.recovery.resolve");
    const set = yield* decodeCommand({
      type: "thread.recovery.set",
      commandId: "command-2",
      threadId: "thread-1",
      recovery,
      createdAt: at,
    });
    assert.strictEqual(set.type, "thread.recovery.set");
  }),
);

it.effect("decodes tool activity payloads with and without itemId", () =>
  Effect.gen(function* () {
    const legacy = yield* decodeToolPayload({ itemType: "command_execution", detail: "ls" });
    assert.strictEqual(legacy.itemId, undefined);
    const paired = yield* decodeToolPayload({ itemType: "command_execution", itemId: "item-7" });
    assert.strictEqual(paired.itemId, "item-7");
  }),
);

it.effect("decodes a sleepRecovery origin segment", () =>
  Effect.gen(function* () {
    const origin = yield* decodeOrigin({
      kind: "sleepRecovery",
      actor: "automation",
      text: "Continue",
      sourceThreads: [],
      verified: true,
    });
    assert.strictEqual(origin.kind, "sleepRecovery");
  }),
);
