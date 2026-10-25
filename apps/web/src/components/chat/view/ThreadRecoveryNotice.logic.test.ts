import type { MessageId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type {
  ThreadTurnStartRecoveryStep,
  ThreadTurnStartRequest,
} from "../../../models/types/app.types";
import {
  deriveThreadRecoveryNotice,
  observeTurnStartRequest,
  RECONNECTING_NOTICE_DELAY_MS,
  RECOVERED_NOTICE_VISIBLE_MS,
} from "./ThreadRecoveryNotice.logic";
import type { ServerTurnFailure } from "./ThreadRecoveryNotice.failure";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
// The request's command clock is an hour ahead of the browser: durations must ignore it.
const SKEWED_REQUESTED_AT = new Date(T0 + 3_600_000).toISOString();
const request = (
  outcome: ThreadTurnStartRequest["outcome"] = "pending",
  recoverySteps: ReadonlyArray<ThreadTurnStartRecoveryStep> = [],
): ThreadTurnStartRequest => ({
  messageId: "user-1" as MessageId,
  requestedAt: SKEWED_REQUESTED_AT,
  outcome,
  settledAt: outcome === "pending" ? null : SKEWED_REQUESTED_AT,
  recoverySteps,
});
const failureOf = (failureClass: string): ServerTurnFailure => ({
  pendingMessageId: "user-1" as MessageId,
  failureEventId: "failure-1",
  failureClass,
});
const derive = (
  req: ThreadTurnStartRequest | null,
  nowOffsetMs: number,
  options: { settledAfterMs?: number; failure?: ServerTurnFailure } = {},
) =>
  deriveThreadRecoveryNotice({
    request: req,
    clock:
      req === null
        ? null
        : {
            requestKey: "user-1",
            observedAtMs: T0,
            settledObservedAtMs:
              options.settledAfterMs === undefined ? null : T0 + options.settledAfterMs,
          },
    failure: options.failure ?? null,
    nowMs: T0 + nowOffsetMs,
  });

describe("deriveThreadRecoveryNotice", () => {
  it("stays hidden without a request or a server-side failure", () => {
    expect(derive(null, 60_000)).toEqual({ notice: null, nextChangeInMs: null });
  });

  it("shows blue Reconnecting after 5 s measured on the browser clock only", () => {
    expect(RECONNECTING_NOTICE_DELAY_MS).toBe(5_000);
    expect(derive(request(), 4_999)).toEqual({ notice: null, nextChangeInMs: 1 });
    const shown = derive(request(), 5_000).notice;
    expect(shown).toMatchObject({ kind: "reconnecting", tone: "info", title: "Reconnecting…" });
  });

  it("shows Reconnecting immediately once the server reports a recovery step", () => {
    const steps = [{ step: "revive", outcome: "started" }];
    const shown = derive(request("pending", steps), 1_000).notice;
    expect(shown).toMatchObject({ kind: "reconnecting", tone: "info" });
    expect(shown?.description).toContain("Reconnecting to the provider session");
  });

  it("turns green when the turn starts after a visible wait, then hides", () => {
    expect(derive(request("started"), 8_000, { settledAfterMs: 7_000 })).toMatchObject({
      notice: { kind: "recovered", tone: "success", title: "Reconnected" },
      nextChangeInMs: RECOVERED_NOTICE_VISIBLE_MS - 1_000,
    });
    const hidden = derive(request("started"), 7_000 + RECOVERED_NOTICE_VISIBLE_MS, {
      settledAfterMs: 7_000,
    });
    expect(hidden.notice).toBeNull();
  });

  it("turns amber when recovery fell back to a fresh session with transcript replay", () => {
    const steps = [
      { step: "revive", outcome: "failed" },
      { step: "fresh-replay", outcome: "succeeded" },
    ];
    expect(
      derive(request("started", steps), 1_500, { settledAfterMs: 1_000 }).notice,
    ).toMatchObject({ kind: "degraded", tone: "warning" });
  });

  it("turns red when the start fails after a visible wait and stays until the next request", () => {
    const failed = derive(request("failed"), 600_000, { settledAfterMs: 6_000 });
    expect(failed.notice).toMatchObject({ kind: "failed", tone: "error" });
  });

  it("offers continuing in a new thread while reconnecting or after a failure", () => {
    expect(derive(request(), 5_000).notice?.canContinueInNewThread).toBe(true);
    const failed = derive(request("failed"), 7_000, { settledAfterMs: 6_000 });
    expect(failed.notice?.canContinueInNewThread).toBe(true);
    const started = derive(request("started"), 8_000, { settledAfterMs: 7_000 });
    expect(started.notice?.canContinueInNewThread).toBe(false);
  });

  it("shows a fork-only failure from server state alone, so it survives a reload", () => {
    for (const failureClass of ["session-dead", "unsafe-to-replay"]) {
      const notice = derive(null, 0, { failure: failureOf(failureClass) }).notice;
      expect(notice).toMatchObject({ kind: "failed", tone: "error", canContinueInNewThread: true });
    }
    expect(derive(null, 0, { failure: failureOf("auth-or-quota") }).notice).toBeNull();
  });

  it("explains an unavailable provider and offers only the manual new-thread action", () => {
    const notice = derive(null, 0, { failure: failureOf("provider-unavailable") }).notice;
    expect(notice).toMatchObject({ kind: "failed", tone: "error", canContinueInNewThread: true });
    expect(notice?.description).toMatch(/not available/i);
  });

  it("does not describe a setup or uncertain-admission refusal as permanent session loss", () => {
    const notice = derive(null, 0, { failure: failureOf("unsafe-to-replay") }).notice;
    expect(notice).toMatchObject({ kind: "failed", tone: "error", canContinueInNewThread: true });
    expect(notice?.description).toContain("resolve the error above before sending again");
    expect(notice?.description).not.toContain("session cannot be resumed");
    expect(derive(null, 0, { failure: failureOf("session-dead") }).notice?.description).toContain(
      "session cannot be resumed",
    );
  });

  it("offers the manual new-thread action for a rejected request such as a retired model", () => {
    const notice = derive(null, 0, { failure: failureOf("invalid-request") }).notice;
    expect(notice).toMatchObject({ kind: "failed", tone: "error", canContinueInNewThread: true });
    expect(notice?.description).toMatch(/model/i);
  });

  it("a started retry of the failed message replaces the failure notice", () => {
    const options = { settledAfterMs: 800, failure: failureOf("session-dead") };
    expect(derive(request("started"), 1_000, options).notice).toBeNull();
  });

  it("never shows anything for fast starts or fast in-place failures", () => {
    expect(derive(request("started"), 1_000, { settledAfterMs: 800 }).notice).toBeNull();
    expect(derive(request("failed"), 1_000, { settledAfterMs: 800 }).notice).toBeNull();
  });
});

describe("observeTurnStartRequest", () => {
  const pending = request();
  it("keeps the first browser observation and records the settlement once", () => {
    const first = observeTurnStartRequest(undefined, pending, T0);
    expect(first).toEqual({
      requestKey: expect.any(String),
      observedAtMs: T0,
      settledObservedAtMs: null,
    });
    expect(observeTurnStartRequest(first ?? undefined, pending, T0 + 9_000)).toBe(first);
    const settled = observeTurnStartRequest(first ?? undefined, request("started"), T0 + 7_000);
    expect(settled).toMatchObject({ observedAtMs: T0, settledObservedAtMs: T0 + 7_000 });
    expect(observeTurnStartRequest(settled ?? undefined, request("started"), T0 + 9_000)).toBe(
      settled,
    );
  });

  it("restarts for a new request and forgets a cleared one", () => {
    const first = observeTurnStartRequest(undefined, pending, T0) ?? undefined;
    const next = { ...pending, messageId: "user-2" as MessageId };
    expect(observeTurnStartRequest(first, next, T0 + 50)).toMatchObject({ observedAtMs: T0 + 50 });
    expect(observeTurnStartRequest(first, null, T0 + 50)).toBeNull();
  });
});
