import type { CommandId, MessageId, ThreadId } from "@bigbud/contracts";
import type { ThreadRecovery } from "@bigbud/contracts/orchestration/orchestration.recovery.ts";
import { describe, expect, it } from "vitest";

import { observeSleepRecoveryState } from "./ThreadRecoveryNotice.clock";
import {
  buildThreadRecoveryResolveCommand,
  deriveSleepRecoveryNotice,
  PROVIDER_CONTINUED_NOTICE_MS,
  RESUMING_NOTICE_DELAY_MS,
  sleepRecoveryStateKey,
} from "./ThreadSleepRecoveryNotice.logic";

const recovery = (overrides: Partial<ThreadRecovery>): ThreadRecovery => ({
  status: "awaiting-user",
  reason: null,
  toolSummary: null,
  attempt: 0,
  provider: "claudeAgent",
  messageId: "message-1" as MessageId,
  updatedAt: "2026-10-22T10:00:00.000Z",
  ...overrides,
});

const derive = (value: ThreadRecovery | null, elapsedMs = 0) =>
  deriveSleepRecoveryNotice({ recovery: value, observedAtMs: 1_000, nowMs: 1_000 + elapsedMs });

describe("deriveSleepRecoveryNotice", () => {
  it("hides 'Resuming after sleep…' for the first 3 s, then shows it in blue", () => {
    const continuing = recovery({ status: "continuing", reason: "interrupted-by-sleep" });
    expect(derive(continuing, 2_999)).toEqual({ notice: null, nextChangeInMs: 1 });
    expect(derive(continuing, RESUMING_NOTICE_DELAY_MS)).toEqual({
      notice: { kind: "resuming", tone: "info", description: "Resuming after sleep…", actions: [] },
      nextChangeInMs: null,
    });
  });

  it("names the provider that continued on its own for 6 s", () => {
    const continued = recovery({ status: "provider-continued", reason: "provider-continued" });
    expect(derive(continued, 1_000)).toMatchObject({
      notice: {
        kind: "provider-continued",
        tone: "info",
        description: "Claude continued on its own after sleep.",
      },
      nextChangeInMs: PROVIDER_CONTINUED_NOTICE_MS - 1_000,
    });
    expect(derive(continued, PROVIDER_CONTINUED_NOTICE_MS).notice).toBeNull();
    expect(derive({ ...continued, provider: null }, 0).notice?.description).toBe(
      "The provider continued on its own after sleep.",
    );
  });

  it("names the tool whose outcome is unknown, never failed or cancelled", () => {
    const notice = derive(recovery({ reason: "tool-in-flight", toolSummary: "npm test" })).notice;
    expect(notice).toEqual({
      kind: "tool-outcome-unknown",
      tone: "warning",
      description:
        "The computer slept while npm test was running. Its outcome is unknown. Check before continuing.",
      actions: [
        { action: "continue", label: "Continue" },
        { action: "dismiss", label: "Dismiss" },
      ],
    });
    expect(notice?.description).not.toMatch(/failed|cancelled/i);
    expect(derive(recovery({ reason: "tool-in-flight" })).notice?.description).toContain(
      "while a tool was running",
    );
  });

  it("says the response was interrupted, in amber, when no tool was running", () => {
    const notice = derive(recovery({ reason: "interrupted-by-sleep" })).notice;
    expect(notice).toEqual({
      kind: "interrupted",
      tone: "warning",
      description: "The response was interrupted when the computer went to sleep.",
      actions: [
        { action: "continue", label: "Continue" },
        { action: "dismiss", label: "Dismiss" },
      ],
    });
    expect(notice?.description).not.toMatch(/tool|unknown/i);
    // A tool named by an earlier state does not bring the tool text back.
    expect(
      derive(recovery({ reason: "interrupted-by-sleep", toolSummary: "npm test" })).notice?.kind,
    ).toBe("interrupted");
  });

  it("reports a failed Continue in red and lets the user try again or dismiss", () => {
    expect(derive(recovery({ reason: "continuation-failed" })).notice).toEqual({
      kind: "resume-failed",
      tone: "error",
      description: "Couldn't resume after sleep.",
      actions: [
        { action: "continue", label: "Continue" },
        { action: "dismiss", label: "Dismiss" },
      ],
    });
  });

  it("offers Keep waiting or Stop and continue when nothing happened since wake", () => {
    expect(derive(recovery({ reason: "no-activity-after-wake" })).notice).toMatchObject({
      kind: "no-activity",
      tone: "warning",
      description: "No activity since wake.",
      actions: [
        { action: "keep-waiting", label: "Keep waiting" },
        { action: "stop-and-continue", label: "Stop and continue" },
      ],
    });
  });

  it("asks after a post-wake backend restart", () => {
    expect(derive(recovery({ reason: "backend-restarted-after-wake" })).notice).toMatchObject({
      kind: "backend-restarted",
      tone: "warning",
      description: "bigbud restarted after wake. This turn's outcome is unknown.",
      actions: [{ action: "continue" }, { action: "dismiss" }],
    });
  });

  it("parks in red with Retry after three failed attempts", () => {
    expect(
      derive(recovery({ status: "parked", reason: "continuation-failed", attempt: 3 })).notice,
    ).toEqual({
      kind: "parked",
      tone: "error",
      description: "Couldn't resume after 3 tries.",
      actions: [{ action: "retry", label: "Retry" }],
    });
  });

  it("shows nothing while classifying, observing, after continuing, or without recovery", () => {
    for (const status of ["none", "interrupted-by-sleep", "observing", "continued"] as const) {
      expect(derive(recovery({ status }))).toEqual({ notice: null, nextChangeInMs: null });
    }
    expect(derive(null)).toEqual({ notice: null, nextChangeInMs: null });
  });
});

describe("sleep recovery identity and commands", () => {
  it("keys a state by turn, status and reason, not by its refresh time", () => {
    const base = recovery({ reason: "tool-in-flight" });
    expect(sleepRecoveryStateKey({ ...base, updatedAt: "2026-10-22T11:00:00.000Z" })).toBe(
      sleepRecoveryStateKey(base),
    );
    expect(sleepRecoveryStateKey({ ...base, status: "parked" })).not.toBe(
      sleepRecoveryStateKey(base),
    );
  });

  it("keys each try apart, so a later try gets its own 3 s hide and dismissal", () => {
    const second = recovery({ status: "continuing", reason: "continuation-failed", attempt: 2 });
    const third = { ...second, attempt: 3 };
    expect(sleepRecoveryStateKey(third)).not.toBe(sleepRecoveryStateKey(second));
    const threadId = "thread-tries" as ThreadId;
    expect(observeSleepRecoveryState(threadId, sleepRecoveryStateKey(second), 1_000)).toBe(1_000);
    expect(observeSleepRecoveryState(threadId, sleepRecoveryStateKey(third), 9_000)).toBe(9_000);
  });

  it("builds a resolve command that names the interrupted turn", () => {
    expect(
      buildThreadRecoveryResolveCommand({
        threadId: "thread-1" as ThreadId,
        recovery: recovery({}),
        action: "continue",
        commandId: "command-1" as CommandId,
        createdAt: "2026-10-22T10:00:01.000Z",
      }),
    ).toEqual({
      type: "thread.recovery.resolve",
      commandId: "command-1",
      threadId: "thread-1",
      action: "continue",
      messageId: "message-1",
      createdAt: "2026-10-22T10:00:01.000Z",
    });
  });
});
