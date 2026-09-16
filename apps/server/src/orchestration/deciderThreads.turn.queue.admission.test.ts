import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideThreadQueueCommand } from "./deciderThreads.turn.queue.ts";
import { decideThreadTurnStartCommand } from "./deciderThreads.turn.start.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-08-01T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("thread-admission");
const replyId = MessageId.makeUnsafe("reply-source");

function readModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    updatedAt: now,
    threads: [
      {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project-admission"),
        title: "Admission",
        elevatorSummary: null,
        elevatorSummaryMessageCount: 0,
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        queuedPrompts: [],
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        pinnedAt: null,
        deletingAt: null,
        deletedAt: null,
        messages: [
          {
            id: replyId,
            role: "assistant",
            text: "Earlier answer",
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        ],
        proposedPlans: [
          {
            id: "plan-admission",
            turnId: null,
            planMarkdown: "1. Keep the metadata.",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        tasks: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        watchingThreads: [],
      },
    ],
  };
}

const promptCommand = {
  type: "thread.turn.start" as const,
  commandId: CommandId.makeUnsafe("direct-admission"),
  threadId,
  message: {
    messageId: MessageId.makeUnsafe("queued-metadata"),
    role: "user" as const,
    text: "Retain every field",
    attachments: [
      {
        type: "file" as const,
        id: "file-admission",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
      },
    ],
    replyToMessageId: replyId,
  },
  modelSelection: { provider: "codex" as const, model: "gpt-5.4-mini" },
  titleSeed: "Admission title",
  runtimeMode: "approval-required" as const,
  interactionMode: "plan" as const,
  bootstrapSourceThreadId: ThreadId.makeUnsafe("bootstrap-source"),
  sourceProposedPlan: { threadId, planId: "plan-admission" },
  createdAt: now,
};

describe("direct prompt admission", () => {
  it("projects and flushes busy direct-start metadata without losing it", async () => {
    const initial = readModel();
    const queued = await Effect.runPromise(
      decideThreadTurnStartCommand({ command: promptCommand, readModel: initial }),
    );
    expect(queued.map((event) => event.type)).toEqual(["thread.prompt-queued"]);
    expect(queued[0]).toMatchObject({
      payload: {
        prompt: {
          id: "queued-metadata",
          text: "Retain every field",
          attachments: [{ id: "file-admission" }],
          replyTo: { messageId: replyId },
          modelSelection: { model: "gpt-5.4-mini" },
          titleSeed: "Admission title",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          bootstrapSourceThreadId: "bootstrap-source",
          sourceProposedPlan: { threadId, planId: "plan-admission" },
        },
      },
    });

    const projected = await Effect.runPromise(
      projectEvent(initial, { ...queued[0]!, sequence: 1 } as OrchestrationEvent),
    );
    const idle = {
      ...projected,
      threads: projected.threads.map((thread) => {
        if (thread.id !== threadId) return thread;
        return Object.assign({}, thread, {
          session: Object.assign({}, thread.session!, {
            status: "ready" as const,
            activeTurnId: null,
          }),
        });
      }),
    };
    const flushedResult = await Effect.runPromise(
      decideThreadQueueCommand({
        command: {
          type: "thread.queued-prompt.flush",
          commandId: CommandId.makeUnsafe("flush-admission"),
          threadId,
          messageIds: [MessageId.makeUnsafe("queued-metadata")],
          messageId: MessageId.makeUnsafe("synthetic-flush-message"),
          createdAt: now,
        },
        readModel: idle,
      }),
    );
    const flushed = Array.isArray(flushedResult) ? flushedResult : [flushedResult];
    expect(flushed.map((event) => event.type)).toEqual([
      "thread.queued-prompts-flushed",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(flushed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.message-sent",
          payload: expect.objectContaining({
            messageId: "queued-metadata",
            attachments: [expect.objectContaining({ id: "file-admission" })],
            replyTo: expect.objectContaining({ messageId: replyId }),
          }),
        }),
        expect.objectContaining({
          type: "thread.turn-start-requested",
          payload: expect.objectContaining({
            messageId: "queued-metadata",
            modelSelection: expect.objectContaining({ model: "gpt-5.4-mini" }),
            titleSeed: "Admission title",
            runtimeMode: "approval-required",
            interactionMode: "plan",
            bootstrapSourceThreadId: "bootstrap-source",
            sourceProposedPlan: { threadId, planId: "plan-admission" },
          }),
        }),
      ]),
    );
  });
});
