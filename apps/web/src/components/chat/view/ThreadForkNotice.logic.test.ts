import type { CommandId, MessageId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  buildContinueInNewThreadCommand,
  deriveForkOriginNotice,
  deriveSourceForkNotice,
} from "./ThreadForkNotice.logic";

const activity = (kind: string, createdAt: string, payload: unknown, id = `${kind}-${createdAt}`) =>
  ({ id, kind, payload, createdAt, tone: "info", summary: kind, turnId: null }) as never;

describe("fork notices", () => {
  it("names the source in a forked thread and explains the pending message", () => {
    expect(deriveForkOriginNotice({ forkOrigin: undefined, parentThread: undefined })).toBeNull();
    const notice = deriveForkOriginNotice({
      parentThread: { threadId: "source-1" as ThreadId, title: "Long running work" },
      forkOrigin: {
        forkPointMessageId: null,
        reason: "recovery-failed",
        failureEventId: null,
        pendingDelivery: "held",
      },
    });
    expect(notice).toMatchObject({ sourceThreadId: "source-1", sourceTitle: "Long running work" });
    expect(notice?.description).toMatch(/could not be resumed/i);
    expect(notice?.description).toMatch(/queue/i);
  });

  it("links a source thread to its newest fork made after the latest user message", () => {
    const thread = {
      messages: [{ role: "user", createdAt: "2026-10-15T10:00:00.000Z" }],
      activities: [
        activity("thread.forked", "2026-10-15T09:00:00.000Z", { forkThreadId: "old" }),
        activity("thread.forked", "2026-10-15T10:00:05.000Z", {
          forkThreadId: "fork-2",
          reason: "recovery-failed",
        }),
      ],
    } as never;
    expect(deriveSourceForkNotice(thread)).toEqual({ forkThreadId: "fork-2", automatic: true });
    expect(
      deriveSourceForkNotice({
        messages: [{ role: "user", createdAt: "2026-10-15T11:00:00.000Z" }],
        activities: (thread as { activities: unknown[] }).activities,
      } as never),
    ).toBeNull();
  });

  it("builds a manual fork command for the pending request and its failure", () => {
    const command = buildContinueInNewThreadCommand({
      thread: {
        id: "source-1" as ThreadId,
        turnStartRequest: {
          messageId: "user-9" as MessageId,
          requestedAt: "2026-10-15T10:00:00.000Z",
          outcome: "failed",
          settledAt: "2026-10-15T10:00:09.000Z",
        },
        activities: [
          activity("provider.turn.start.failed", "2026-10-15T09:00:00.000Z", {}, "old-failure"),
          activity("provider.turn.start.failed", "2026-10-15T10:00:09.000Z", {}, "failure-9"),
        ],
      },
      commandId: "cmd-1" as CommandId,
      threadId: "fork-1" as ThreadId,
      createdAt: "2026-10-15T10:01:00.000Z",
    });
    expect(command).toEqual({
      type: "thread.fork",
      commandId: "cmd-1",
      sourceThreadId: "source-1",
      threadId: "fork-1",
      reason: "manual",
      failureEventId: "failure-9",
      pendingMessageId: "user-9",
      createdAt: "2026-10-15T10:01:00.000Z",
    });
  });
});
