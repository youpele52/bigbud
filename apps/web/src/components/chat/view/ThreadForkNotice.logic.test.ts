import type { CommandId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  buildCarryToContinuedThreadCommand,
  buildContinueInNewThreadCommand,
  deriveForkOriginNotice,
  deriveSourceForkNotice,
} from "./ThreadForkNotice.logic";

const activity = (kind: string, createdAt: string, payload: unknown, id = `${kind}-${createdAt}`) =>
  ({ id, kind, payload, createdAt, tone: "info", summary: kind, turnId: null }) as never;
const user = (id: string, createdAt: string) =>
  ({ id, role: "user", turnId: null, createdAt }) as never;
const failed = (id: string, createdAt: string, failureClass: string) =>
  activity("provider.turn.start.failed", createdAt, { failureClass }, id);
const autoFork = (createdAt: string, pendingMessageId: string) =>
  activity("thread.forked", createdAt, {
    forkThreadId: "auto-fork",
    reason: "recovery-failed",
    pendingMessageId,
  });

const present = () => true;

describe("fork notices", () => {
  it("names the source in a forked thread and explains the pending message", () => {
    expect(
      deriveForkOriginNotice({ forkOrigin: undefined, parentThread: undefined, activities: [] }),
    ).toBeNull();
    const notice = deriveForkOriginNotice({
      parentThread: { threadId: "source-1" as ThreadId, title: "Long running work" },
      forkOrigin: {
        forkPointMessageId: null,
        reason: "recovery-failed",
        failureEventId: null,
        pendingDelivery: "held",
      },
      activities: [],
    });
    expect(notice).toMatchObject({ sourceThreadId: "source-1", sourceTitle: "Long running work" });
    expect(notice?.description).toMatch(/could not be resumed/i);
    expect(notice?.description).toMatch(/queue/i);
  });

  it("warns in amber when the message was sent again after an earlier fork received it", () => {
    const input = {
      parentThread: { threadId: "source-1" as ThreadId, title: "Work" },
      forkOrigin: {
        forkPointMessageId: null,
        reason: "manual" as const,
        failureEventId: null,
        pendingDelivery: "sent" as const,
      },
    };
    expect(deriveForkOriginNotice({ ...input, activities: [] })?.tone).toBe("info");
    const notice = deriveForkOriginNotice({
      ...input,
      activities: [
        activity("thread.fork-origin", "2026-10-15T10:00:00.000Z", {
          pendingDelivery: "sent",
          redelivered: true,
        }),
      ],
    });
    expect(notice?.tone).toBe("warning");
    expect(notice?.description).toMatch(/sent again/i);
    expect(notice?.description).toMatch(/workspace changes/i);
  });

  it("links a source thread to its newest fork made after the latest user message", () => {
    const activities = [
      activity("thread.forked", "2026-10-15T09:00:00.000Z", {
        forkThreadId: "old",
        reason: "manual",
      }),
      activity("thread.forked", "2026-10-15T10:00:05.000Z", {
        forkThreadId: "fork-2",
        reason: "manual",
      }),
    ];
    const thread = { messages: [user("m-1", "2026-10-15T10:00:00.000Z")], activities } as never;
    expect(deriveSourceForkNotice(thread, present)).toEqual({
      forkThreadId: "fork-2",
      automatic: false,
      carry: null,
    });
    const later = { messages: [user("m-2", "2026-10-15T11:00:00.000Z")], activities } as never;
    expect(deriveSourceForkNotice(later, present)).toBeNull();
  });

  it("keeps linking the automatic fork while the source stays dead and offers the carry", () => {
    const thread = {
      id: "source-1",
      messages: [user("m-1", "2026-10-15T10:00:00.000Z"), user("m-2", "2026-10-15T11:00:00.000Z")],
      activities: [
        failed("failure-1", "2026-10-15T10:00:00.000Z", "session-dead"),
        autoFork("2026-10-15T10:00:01.000Z", "m-1"),
        failed("failure-2", "2026-10-15T11:00:00.000Z", "session-dead"),
      ],
    } as never;
    const notice = deriveSourceForkNotice(thread, present);
    expect(notice).toEqual({
      forkThreadId: "auto-fork",
      automatic: true,
      carry: { pendingMessageId: "m-2", failureEventId: "failure-2" },
    });
    expect(
      buildCarryToContinuedThreadCommand({
        sourceThreadId: "source-1" as ThreadId,
        forkThreadId: notice!.forkThreadId,
        carry: notice!.carry!,
        commandId: "cmd-carry" as CommandId,
        createdAt: "2026-10-15T11:01:00.000Z",
      }),
    ).toEqual({
      type: "thread.fork",
      commandId: "cmd-carry",
      sourceThreadId: "source-1",
      threadId: "auto-fork",
      reason: "manual",
      failureEventId: "failure-2",
      pendingMessageId: "m-2",
      createdAt: "2026-10-15T11:01:00.000Z",
    });
  });

  it("offers the carry even when the server's fork timestamp is ahead of the browser's message", () => {
    const thread = {
      messages: [user("m-1", "2026-10-15T10:00:00.000Z"), user("m-2", "2026-10-15T11:00:00.000Z")],
      activities: [
        autoFork("2026-10-15T12:00:00.000Z", "m-1"),
        failed("failure-2", "2026-10-15T11:00:00.000Z", "session-dead"),
      ],
    } as never;
    expect(deriveSourceForkNotice(thread, present)?.carry).toEqual({
      pendingMessageId: "m-2",
      failureEventId: "failure-2",
    });
  });

  it("ignores a deleted fork: no link, and the manual action comes back", () => {
    const activities = [
      autoFork("2026-10-15T10:00:01.000Z", "m-1"),
      activity("thread.forked", "2026-10-15T10:00:02.000Z", {
        forkThreadId: "manual-fork",
        reason: "manual",
      }),
    ];
    const thread = { messages: [user("m-1", "2026-10-15T10:00:00.000Z")], activities } as never;
    expect(deriveSourceForkNotice(thread, present)?.forkThreadId).toBe("manual-fork");
    expect(deriveSourceForkNotice(thread, (id) => id === "auto-fork")?.forkThreadId).toBe(
      "auto-fork",
    );
    expect(deriveSourceForkNotice(thread, () => false)).toBeNull();
  });

  it("never offers the carry for an uncertain message", () => {
    const thread = {
      messages: [user("m-1", "2026-10-15T10:00:00.000Z"), user("m-2", "2026-10-15T11:00:00.000Z")],
      activities: [
        autoFork("2026-10-15T10:00:01.000Z", "m-1"),
        failed("failure-2", "2026-10-15T11:00:00.000Z", "unsafe-to-replay"),
      ],
    } as never;
    expect(deriveSourceForkNotice(thread, present)).toMatchObject({
      forkThreadId: "auto-fork",
      carry: null,
    });
  });

  it("builds the manual fork command from server state, without a client request (reload)", () => {
    const command = buildContinueInNewThreadCommand({
      thread: {
        id: "source-1" as ThreadId,
        turnStartRequest: undefined,
        messages: [user("user-9", "2026-10-15T10:00:00.000Z")],
        activities: [
          failed("old-failure", "2026-10-15T09:00:00.000Z", "session-dead"),
          failed("failure-9", "2026-10-15T10:00:00.000Z", "unsafe-to-replay"),
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
