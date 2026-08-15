import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  makeLifecycleQueuedPromptFlushCommand,
  makeQueuedPromptFlushCommand,
} from "./QueuedPromptFlush.logic.ts";

const threadId = ThreadId.makeUnsafe("thread");
const trigger = {
  type: "thread.session.set" as const,
  commandId: CommandId.makeUnsafe("session"),
  threadId,
  session: {
    threadId,
    status: "idle" as const,
    providerName: "codex" as const,
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
};

const model = (overrides = {}) =>
  ({
    threads: [
      {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project"),
        queuedPrompts: [
          { id: MessageId.makeUnsafe("one"), text: "one", createdAt: trigger.createdAt },
        ],
        session: null,
        title: "Thread",
        archivedAt: null,
        latestTurn: null,
        proposedPlans: [],
        messages: [],
        updatedAt: trigger.createdAt,
        activities: [],
        ...overrides,
      },
    ],
  }) as never;

describe("makeLifecycleQueuedPromptFlushCommand", () => {
  it("creates a deterministic exact-prefix flush after reconciliation", () => {
    const first = makeLifecycleQueuedPromptFlushCommand({
      trigger,
      readModel: model(),
      createdAt: trigger.createdAt,
    });
    const second = makeLifecycleQueuedPromptFlushCommand({
      trigger,
      readModel: model(),
      createdAt: "later",
    });
    expect(first).toMatchObject({ type: "thread.queued-prompt.flush", messageIds: ["one"] });
    expect(first?.commandId).toBe(second?.commandId);
  });

  it("blocks flush for active approval or user-input state", () => {
    expect(
      makeLifecycleQueuedPromptFlushCommand({
        trigger,
        readModel: model({
          activities: [
            {
              id: "approval",
              kind: "approval.requested",
              createdAt: trigger.createdAt,
              payload: { requestId: "approval-1" },
            },
          ],
        }),
        createdAt: trigger.createdAt,
      }),
    ).toBeNull();
    expect(
      makeLifecycleQueuedPromptFlushCommand({
        trigger,
        readModel: model({
          activities: [
            {
              id: "input",
              kind: "user-input.requested",
              createdAt: trigger.createdAt,
              payload: { requestId: "input-1", questions: [{}] },
            },
          ],
        }),
        createdAt: trigger.createdAt,
      }),
    ).toBeNull();
  });

  it.each([
    "provider.checking",
    "provider.recovering",
    "provider.stalled",
    "provider.lost-session",
  ])("does not flush %s while its active turn is preserved", (reason) => {
    expect(
      makeLifecycleQueuedPromptFlushCommand({
        trigger,
        readModel: model({
          session: {
            ...trigger.session,
            status: "error",
            activeTurnId: "preserved-turn",
            reason,
          },
        }),
        createdAt: trigger.createdAt,
      }),
    ).toBeNull();
  });

  it.each(["ready", "error"] as const)(
    "flushes terminal %s state after the active turn is cleared",
    (status) => {
      expect(
        makeLifecycleQueuedPromptFlushCommand({
          trigger,
          readModel: model({ session: { ...trigger.session, status, activeTurnId: null } }),
          createdAt: trigger.createdAt,
        }),
      ).toMatchObject({ type: "thread.queued-prompt.flush" });
    },
  );

  it("derives startup recovery with deterministic IDs that change with the prefix", () => {
    const first = makeQueuedPromptFlushCommand({
      threadId,
      readModel: model(),
      createdAt: trigger.createdAt,
    });
    const duplicate = makeQueuedPromptFlushCommand({
      threadId,
      readModel: model(),
      createdAt: "later",
    });
    const changed = makeQueuedPromptFlushCommand({
      threadId,
      readModel: model({
        queuedPrompts: [
          { id: MessageId.makeUnsafe("one"), text: "one", createdAt: trigger.createdAt },
          { id: MessageId.makeUnsafe("two"), text: "two", createdAt: trigger.createdAt },
        ],
      }),
      createdAt: trigger.createdAt,
    });
    expect(first?.commandId).toBe(duplicate?.commandId);
    expect(first?.commandId).not.toBe(changed?.commandId);
    expect(first?.type).toBe("thread.queued-prompt.flush");
    expect(changed?.type).toBe("thread.queued-prompt.flush");
    if (first?.type === "thread.queued-prompt.flush" && changed?.type === first.type) {
      expect(first.messageId).not.toBe(changed.messageId);
    }
  });

  it("blocks startup recovery for unavailable, running, approval, and user-input threads", () => {
    for (const overrides of [
      { archivedAt: trigger.createdAt },
      { deletingAt: trigger.createdAt },
      { deletedAt: trigger.createdAt },
      { session: { ...trigger.session, status: "running", activeTurnId: "turn" } },
      {
        activities: [
          {
            id: "approval",
            kind: "approval.requested",
            createdAt: trigger.createdAt,
            payload: { requestId: "approval-1" },
          },
        ],
      },
      {
        activities: [
          {
            id: "input",
            kind: "user-input.requested",
            createdAt: trigger.createdAt,
            payload: { requestId: "input-1", questions: [{}] },
          },
        ],
      },
    ]) {
      expect(
        makeQueuedPromptFlushCommand({
          threadId,
          readModel: model(overrides),
          createdAt: trigger.createdAt,
        }),
      ).toBeNull();
    }
  });
});
