import type { MessageId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadTurnStartRequest } from "../../../models/types/app.types";
import {
  deriveThreadRecoveryNotice,
  PROVIDER_SESSION_RECOVERY_ACTIVITY_KIND,
  RECONNECTING_NOTICE_DELAY_MS,
  RECOVERED_NOTICE_VISIBLE_MS,
} from "./ThreadRecoveryNotice.logic";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const request = (
  outcome: ThreadTurnStartRequest["outcome"] = "pending",
  settledAfterMs?: number,
): ThreadTurnStartRequest => ({
  messageId: "user-1" as MessageId,
  requestedAt: iso(0),
  outcome,
  settledAt: settledAfterMs === undefined ? null : iso(settledAfterMs),
});
const recovery = (step: string, outcome: string, atMs: number) => ({
  kind: PROVIDER_SESSION_RECOVERY_ACTIVITY_KIND,
  payload: { step, outcome },
  createdAt: iso(atMs),
});
const derive = (
  req: ThreadTurnStartRequest | null,
  nowOffsetMs: number,
  activities: ReturnType<typeof recovery>[] = [],
) => deriveThreadRecoveryNotice({ request: req, activities, nowMs: T0 + nowOffsetMs });

describe("deriveThreadRecoveryNotice", () => {
  it("stays hidden without a request", () => {
    expect(derive(null, 60_000)).toEqual({ notice: null, nextChangeInMs: null });
  });

  it("shows blue Reconnecting only after the 5 s display threshold", () => {
    expect(RECONNECTING_NOTICE_DELAY_MS).toBe(5_000);
    expect(derive(request(), 4_999)).toEqual({ notice: null, nextChangeInMs: 1 });
    const shown = derive(request(), 5_000).notice;
    expect(shown).toMatchObject({ kind: "reconnecting", tone: "info", title: "Reconnecting…" });
  });

  it("shows Reconnecting immediately once the server reports a recovery step", () => {
    const shown = derive(request(), 1_000, [recovery("revive", "started", 500)]).notice;
    expect(shown).toMatchObject({ kind: "reconnecting", tone: "info" });
    expect(shown?.description).toContain("Reconnecting to the provider session");
  });

  it("ignores recovery activities from earlier requests", () => {
    expect(derive(request(), 1_000, [recovery("revive", "started", -60_000)]).notice).toBeNull();
  });

  it("turns green when the turn starts after a visible wait, then hides", () => {
    const started = request("started", 7_000);
    expect(derive(started, 8_000)).toMatchObject({
      notice: { kind: "recovered", tone: "success", title: "Reconnected" },
      nextChangeInMs: RECOVERED_NOTICE_VISIBLE_MS - 1_000,
    });
    expect(derive(started, 7_000 + RECOVERED_NOTICE_VISIBLE_MS).notice).toBeNull();
  });

  it("turns amber when recovery fell back to a fresh session with transcript replay", () => {
    const activities = [
      recovery("revive", "started", 100),
      recovery("revive", "failed", 200),
      recovery("fresh-replay", "started", 300),
      recovery("fresh-replay", "succeeded", 900),
    ];
    expect(derive(request("started", 1_000), 1_500, activities).notice).toMatchObject({
      kind: "degraded",
      tone: "warning",
    });
  });

  it("turns red when the start fails after a visible wait and stays until the next request", () => {
    expect(derive(request("failed", 6_000), 600_000).notice).toMatchObject({
      kind: "failed",
      tone: "error",
    });
  });

  it("offers continuing in a new thread while reconnecting or after a failure", () => {
    expect(derive(request(), 5_000).notice?.canContinueInNewThread).toBe(true);
    expect(derive(request("failed", 6_000), 7_000).notice?.canContinueInNewThread).toBe(true);
    expect(derive(request("started", 7_000), 8_000).notice?.canContinueInNewThread).toBe(false);
  });

  it("shows a fast failure the thread cannot recover from in place (fork is the only path)", () => {
    const failure = {
      kind: "provider.turn.start.failed",
      payload: { failureClass: "unsafe-to-replay" },
      createdAt: iso(500),
    };
    expect(
      deriveThreadRecoveryNotice({
        request: request("failed", 800),
        activities: [failure],
        nowMs: T0 + 1_000,
      }).notice,
    ).toMatchObject({ kind: "failed", tone: "error", canContinueInNewThread: true });
    expect(
      deriveThreadRecoveryNotice({
        request: request("failed", 800),
        activities: [{ ...failure, payload: { failureClass: "auth-or-quota" } }],
        nowMs: T0 + 1_000,
      }).notice,
    ).toBeNull();
  });

  it("explains an unavailable provider and offers only the manual new-thread action", () => {
    const notice = deriveThreadRecoveryNotice({
      request: request("failed", 800),
      activities: [
        {
          kind: "provider.turn.start.failed",
          payload: { failureClass: "provider-unavailable" },
          createdAt: iso(500),
        },
      ],
      nowMs: T0 + 1_000,
    }).notice;
    expect(notice).toMatchObject({ kind: "failed", tone: "error", canContinueInNewThread: true });
    expect(notice?.description).toMatch(/not available/i);
  });

  it("never shows anything for fast starts or fast failures", () => {
    expect(derive(request("started", 800), 1_000).notice).toBeNull();
    expect(derive(request("failed", 800), 1_000).notice).toBeNull();
  });
});
