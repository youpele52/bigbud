import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationCommand } from "./orchestration.commands";
import { ThreadCreatedPayload } from "./orchestration.events.thread";
import { THREAD_FORK_CAPS, ThreadForkOrigin } from "./orchestration.fork";

const created = {
  threadId: "fork-1",
  projectId: "project-1",
  title: "Thread",
  modelSelection: { provider: "codex", model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: "2026-10-15T10:00:00.000Z",
  updatedAt: "2026-10-15T10:00:00.000Z",
};

describe("thread fork contracts", () => {
  it("decodes the thread.fork client command", () => {
    const command = Schema.decodeUnknownSync(OrchestrationCommand)({
      type: "thread.fork",
      commandId: "cmd-fork",
      sourceThreadId: "thread-1",
      threadId: "fork-1",
      reason: "manual",
      pendingMessageId: "user-1",
      createdAt: "2026-10-15T10:00:00.000Z",
    });
    expect(command).toMatchObject({ type: "thread.fork", reason: "manual" });
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationCommand)({
        ...command,
        reason: "because",
      }),
    ).toThrow();
  });

  it("decodes thread.created with and without a fork origin", () => {
    expect(Schema.decodeUnknownSync(ThreadCreatedPayload)(created).forkOrigin).toBeUndefined();
    const forkOrigin = {
      forkPointMessageId: "assistant-9",
      reason: "recovery-failed",
      failureEventId: "turn-start-failed:evt-1",
      pendingDelivery: "held",
    };
    expect(
      Schema.decodeUnknownSync(ThreadCreatedPayload)({ ...created, forkOrigin }).forkOrigin,
    ).toEqual(forkOrigin);
    // Persisted rows carry only the three lineage columns.
    expect(
      Schema.decodeUnknownSync(ThreadForkOrigin)({
        forkPointMessageId: null,
        reason: "manual",
        failureEventId: null,
      }),
    ).toMatchObject({ reason: "manual" });
  });

  it("documents bounded copy caps", () => {
    expect(THREAD_FORK_CAPS).toEqual({
      messages: 200,
      activities: 500,
      proposedPlans: 50,
      tasks: 500,
    });
  });
});
