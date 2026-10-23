import { describe, expect, it } from "vitest";

import {
  applyDesktopHint,
  consumePendingSuspend,
  DESKTOP_PENDING_SUSPEND_MAX_AGE_MS,
  initialDesktopHintState,
  observeSupervisorSuspendedMillis,
  SUPERVISOR_SUSPENDED_JUMP_MS,
} from "./SystemSleepEpochs.sources.logic.ts";

const T0 = 1_761_140_000_000;

describe("applyDesktopHint", () => {
  it("anchors an epoch on resume, starting at the preceding suspend", () => {
    const suspended = applyDesktopHint(initialDesktopHintState, {
      kind: "suspend",
      sequence: 1,
      occurredAt: T0,
      online: true,
    });
    expect(suspended.evidence).toBeNull();
    const resumed = applyDesktopHint(suspended.state, {
      kind: "resume",
      sequence: 2,
      occurredAt: T0 + 600_000,
      online: false,
    });
    expect(resumed.evidence).toEqual({
      source: "desktop-hint",
      startedAtMs: T0,
      endedAtMs: T0 + 600_000,
    });
    expect(resumed.networkOnline).toBe(false);
    expect(resumed.state.online).toBe(false);
  });

  it("handles a missed suspend as an epoch of unknown start", () => {
    const resumed = applyDesktopHint(initialDesktopHintState, {
      kind: "resume",
      sequence: 1,
      occurredAt: T0,
      online: true,
    });
    expect(resumed.evidence).toEqual({ source: "desktop-hint", startedAtMs: T0, endedAtMs: T0 });
    expect(resumed.networkOnline).toBe(true);
  });

  it("drops a pending suspend too old to belong to the resume", () => {
    // logind aborted this suspend, or its resume was missed; the next resume is days later.
    const aborted = applyDesktopHint(initialDesktopHintState, {
      kind: "suspend",
      sequence: 1,
      occurredAt: T0,
      online: true,
    });
    const resumeAt = T0 + DESKTOP_PENDING_SUSPEND_MAX_AGE_MS + 2 * 24 * 3_600_000;
    const resumed = applyDesktopHint(aborted.state, {
      kind: "resume",
      sequence: 2,
      occurredAt: resumeAt,
      online: true,
    });
    expect(resumed.evidence).toEqual({
      source: "desktop-hint",
      startedAtMs: resumeAt,
      endedAtMs: resumeAt,
    });
    expect(resumed.state.pendingSuspendAtMs).toBeNull();
  });

  it("drops duplicate and out-of-order lines", () => {
    const first = applyDesktopHint(initialDesktopHintState, {
      kind: "resume",
      sequence: 5,
      occurredAt: T0,
      online: null,
    });
    const duplicate = applyDesktopHint(first.state, {
      kind: "resume",
      sequence: 5,
      occurredAt: T0,
      online: null,
    });
    expect(duplicate.evidence).toBeNull();
    expect(duplicate.state).toBe(first.state);
  });

  it("reports the network back on an online hint", () => {
    const offline = applyDesktopHint(initialDesktopHintState, {
      kind: "offline",
      sequence: 1,
      occurredAt: T0,
      online: false,
    });
    expect(offline.state.online).toBe(false);
    const online = applyDesktopHint(offline.state, {
      kind: "online",
      sequence: 2,
      occurredAt: T0 + 1,
      online: true,
    });
    expect(online.networkOnline).toBe(true);
    expect(online.state.online).toBe(true);
  });
});

const measured = (startedAtMs: number, endedAtMs: number) => ({
  source: "server-gap" as const,
  startedAtMs,
  endedAtMs,
});

describe("consumePendingSuspend", () => {
  const pending = { ...initialDesktopHintState, pendingSuspendAtMs: T0 };

  it("widens measured evidence to the suspend that announced it", () => {
    const result = consumePendingSuspend(pending, measured(T0 + 2_000, T0 + 600_000));
    expect(result.evidence.startedAtMs).toBe(T0);
    expect(result.state.pendingSuspendAtMs).toBeNull();
  });

  it("uses up an aborted suspend without widening the next sleep", () => {
    const later = T0 + 3 * 24 * 3_600_000;
    const result = consumePendingSuspend(pending, measured(later, later + 600_000));
    expect(result.evidence.startedAtMs).toBe(later);
    expect(result.state.pendingSuspendAtMs).toBeNull();
  });

  it("keeps a suspend that came after the measured sleep ended", () => {
    const result = consumePendingSuspend(pending, measured(T0 - 600_000, T0 - 1_000));
    expect(result.state).toBe(pending);
    expect(result.evidence.startedAtMs).toBe(T0 - 600_000);
  });
});

describe("observeSupervisorSuspendedMillis", () => {
  it("takes the first heartbeat as a baseline", () => {
    const result = observeSupervisorSuspendedMillis(null, 900_000, T0);
    expect(result).toEqual({ state: { suspendedMillis: 900_000 }, evidence: null });
  });

  it("opens an epoch on a jump of at least 15 s", () => {
    const result = observeSupervisorSuspendedMillis(
      { suspendedMillis: 900_000 },
      900_000 + 1_800_000,
      T0,
    );
    expect(result.evidence).toEqual({
      source: "supervisor-clock",
      startedAtMs: T0 - 1_800_000,
      endedAtMs: T0,
    });
  });

  it("ignores small jumps, an unavailable clock and a supervisor restart", () => {
    const base = { suspendedMillis: 900_000 };
    expect(
      observeSupervisorSuspendedMillis(base, 900_000 + SUPERVISOR_SUSPENDED_JUMP_MS - 1, T0)
        .evidence,
    ).toBeNull();
    expect(observeSupervisorSuspendedMillis(base, 0, T0)).toEqual({ state: base, evidence: null });
    expect(observeSupervisorSuspendedMillis(base, 1_000, T0)).toEqual({
      state: { suspendedMillis: 1_000 },
      evidence: null,
    });
  });
});
