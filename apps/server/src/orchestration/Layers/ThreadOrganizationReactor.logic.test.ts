import {
  ApprovalRequestId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ThreadId,
} from "@bigbud/contracts";
import { DEFAULT_THREAD_ORGANIZATION } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { describe, expect, it } from "vitest";

import {
  isOrganizationReactionNeeded,
  organizationReactionForEvent,
} from "./ThreadOrganizationReactor.logic.ts";

const threadId = ThreadId.makeUnsafe("thread-itutu");
const event = (type: string, payload: Record<string, unknown>) =>
  ({ type, payload: { threadId, ...payload } }) as unknown as OrchestrationEvent;
const activity = (kind: string, payload: unknown, id = `${kind}-activity`) =>
  event("thread.activity-appended", {
    activity: { id: EventId.makeUnsafe(id), kind, payload, tone: "approval", turnId: null },
  });
const message = (overrides: Record<string, unknown>) =>
  event("thread.message-sent", {
    messageId: MessageId.makeUnsafe("message-1"),
    role: "user",
    text: "hi",
    streaming: false,
    ...overrides,
  });

describe("organizationReactionForEvent", () => {
  it("moves blocking requests to Needs you, keyed by request id", () => {
    expect(
      organizationReactionForEvent(activity("approval.requested", { requestId: "r1" })),
    ).toEqual({ threadId, state: "needs-you", key: "attention:approval.requested:r1" });
    expect(
      organizationReactionForEvent(activity("user-input.requested", { requestId: "r2" }))?.key,
    ).toBe("attention:user-input.requested:r2");
    expect(
      organizationReactionForEvent(activity("delegation.model-choice-requested", {}, "choice-1"))
        ?.key,
    ).toBe("attention:delegation.model-choice-requested:choice-1");
  });

  it("ignores activities that do not wait on the user", () => {
    expect(organizationReactionForEvent(activity("approval.resolved", { requestId: "r1" }))).toBe(
      null,
    );
    expect(organizationReactionForEvent(activity("runtime.error", {}))).toBe(null);
  });

  it("returns the thread to Present when the user responds", () => {
    const requestId = ApprovalRequestId.makeUnsafe("r1");
    expect(
      organizationReactionForEvent(event("thread.approval-response-requested", { requestId })),
    ).toEqual({ threadId, state: "present", key: "response:r1" });
    expect(
      organizationReactionForEvent(event("thread.user-input-response-requested", { requestId }))
        ?.state,
    ).toBe("present");
  });

  it("counts only the user's own complete messages as work", () => {
    expect(organizationReactionForEvent(message({}))).toEqual({
      threadId,
      state: "present",
      key: "message:message-1",
    });
    expect(
      organizationReactionForEvent(message({ originSegments: [{ actor: "user" }] }))?.state,
    ).toBe("present");
    for (const overrides of [
      { role: "assistant" },
      { streaming: true },
      { replace: true },
      { originSegments: [{ actor: "user" }, { actor: "agent" }] },
      { originSegments: [{ actor: "automation" }] },
    ]) {
      expect(organizationReactionForEvent(message(overrides))).toBe(null);
    }
  });
});

describe("queued prompts", () => {
  const queued = (prompt: Record<string, unknown>) =>
    event("thread.prompt-queued", { prompt: { id: MessageId.makeUnsafe("message-1"), ...prompt } });

  it("shares the sent message's key so a flush cannot replay the move", () => {
    expect(organizationReactionForEvent(queued({}))).toEqual({
      threadId,
      state: "present",
      key: "message:message-1",
    });
  });

  it("ignores redelivered and agent-authored prompts", () => {
    expect(organizationReactionForEvent(queued({ alreadySent: true }))).toBe(null);
    expect(organizationReactionForEvent(queued({ originSegments: [{ actor: "agent" }] }))).toBe(
      null,
    );
  });
});

describe("isOrganizationReactionNeeded", () => {
  it("skips a move into the current state unless a snooze must be cancelled", () => {
    expect(isOrganizationReactionNeeded(DEFAULT_THREAD_ORGANIZATION, { state: "present" })).toBe(
      false,
    );
    expect(isOrganizationReactionNeeded(DEFAULT_THREAD_ORGANIZATION, { state: "needs-you" })).toBe(
      true,
    );
    const snoozed = {
      ...DEFAULT_THREAD_ORGANIZATION,
      state: "later" as const,
      snooze: { id: "s1", until: "2026-10-30T01:00:00.000Z" },
    };
    expect(isOrganizationReactionNeeded(snoozed, { state: "later" })).toBe(true);
  });
});
