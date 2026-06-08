import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { LOCAL_EXECUTION_TARGET_ID } from "../core/baseSchemas";
import { DEFAULT_PROVIDER_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./orchestration.provider";
import {
  OrchestrationEvent,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  ThreadCreatedPayload,
  ThreadMetaUpdatedPayload,
  ThreadTurnStartRequestedPayload,
  ThreadShellRunRequestedPayload,
} from "./orchestration.events";

const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeProjectMetaUpdatedPayload = Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeThreadShellRunRequestedPayload = Schema.decodeUnknownEffect(
  ThreadShellRunRequestedPayload,
);
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.provider, "codex");
    assert.strictEqual(
      parsed.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
      LOCAL_EXECUTION_TARGET_ID,
    );
  }),
);

it.effect("decodes project.meta-updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdatedPayload({
      projectId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.provider, "claudeAgent");
    assert.strictEqual(
      parsed.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
      LOCAL_EXECUTION_TARGET_ID,
    );
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.provider, "codex");
    assert.strictEqual(
      parsed.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
      LOCAL_EXECUTION_TARGET_ID,
    );
  }),
);

it.effect("decodes thread.created parent thread metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-2",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      parentThread: {
        threadId: "thread-1",
        title: "Parent thread",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.deepStrictEqual(parsed.parentThread, {
      threadId: "thread-1",
      title: "Parent thread",
    });
    assert.strictEqual(
      parsed.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
      LOCAL_EXECUTION_TARGET_ID,
    );
  }),
);

it.effect("decodes separate thread runtime and workspace execution targets", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-3",
      projectId: "project-1",
      title: "Thread title",
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "ssh:host=devbox&user=root&port=22&auth=ssh-key",
      modelSelection: {
        provider: "pi",
        model: "sonnet",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.providerRuntimeExecutionTargetId, "local");
    assert.strictEqual(
      parsed.workspaceExecutionTargetId,
      "ssh:host=devbox&user=root&port=22&auth=ssh-key",
    );
    assert.strictEqual(parsed.executionTargetId, undefined);
  }),
);

it.effect("decodes thread.meta-updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.provider, "claudeAgent");
    assert.strictEqual(
      parsed.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
      LOCAL_EXECUTION_TARGET_ID,
    );
  }),
);

it.effect("decodes thread archived and unarchived events", () =>
  Effect.gen(function* () {
    const archived = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-archive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.archived",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-archive-1",
      causationEventId: null,
      correlationId: "cmd-archive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        archivedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unarchived = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unarchive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unarchived",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unarchive-1",
      causationEventId: null,
      correlationId: "cmd-unarchive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    assert.strictEqual(archived.type, "thread.archived");
    assert.strictEqual(archived.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.type, "thread.unarchived");
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.turn-start-requested bootstrap source thread id when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      bootstrapSourceThreadId: "thread-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.bootstrapSourceThreadId, "thread-1");
  }),
);

it.effect("decodes thread.turn-start-requested title seed when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("decodes thread.shell-run-requested payloads", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadShellRunRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-shell-1",
      shellCommand: "git status",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.messageId, "msg-shell-1");
    assert.strictEqual(parsed.shellCommand, "git status");
  }),
);

it.effect("decodes thread.message-sent reply metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationEvent({
      type: "thread.message-sent",
      sequence: 1,
      eventId: "evt-reply-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-reply-1",
      causationEventId: null,
      correlationId: "cmd-reply-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        messageId: "msg-1",
        role: "user",
        text: "follow up",
        replyTo: {
          messageId: "msg-parent",
          role: "assistant",
          createdAt: "2026-01-01T00:00:00.000Z",
          excerpt: "Earlier answer",
        },
        turnId: null,
        streaming: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    if (parsed.type !== "thread.message-sent") {
      assert.fail("expected thread.message-sent event");
    }
    assert.deepStrictEqual(parsed.payload.replyTo, {
      messageId: "msg-parent",
      role: "assistant",
      createdAt: "2026-01-01T00:00:00.000Z",
      excerpt: "Earlier answer",
    });
  }),
);
