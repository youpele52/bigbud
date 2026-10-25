/**
 * Pure per-source readers that turn raw signals into `SleepEvidence`.
 *
 * @module SystemSleepEpochs.sources.logic
 */
import type { DesktopLifecycleHint } from "@bigbud/contracts/server/desktopLifecycleHint.ts";

import { SLEEP_EPOCH_MERGE_WINDOW_MS, type SleepEvidence } from "./SystemSleepEpochs.logic.ts";

// ── Desktop hints (fd 5) ─────────────────────────────────────────────

export interface DesktopHintState {
  readonly lastSequence: number | null;
  /** Electron's `suspend` is a hint only: it may be missing, or late on macOS. */
  readonly pendingSuspendAtMs: number | null;
  readonly online: boolean | null;
}

export const initialDesktopHintState: DesktopHintState = {
  lastSequence: null,
  pendingSuspendAtMs: null,
  online: null,
};

/**
 * A pending suspend older than this at resume is dropped. A suspend that logind aborted, or
 * whose resume was missed, must not stretch a sleep days later back to it. A longer real sleep
 * loses nothing: the gap detector and the supervisor clock measure its start.
 */
export const DESKTOP_PENDING_SUSPEND_MAX_AGE_MS = 10 * 60_000;

export interface DesktopHintResult {
  readonly state: DesktopHintState;
  readonly evidence: SleepEvidence | null;
  /** True when the hint says the network is back. */
  readonly networkOnline: boolean;
}

/**
 * Applies one hint line. Duplicate and out-of-order sequences are dropped. `resume` is the
 * anchor of an epoch; without a preceding `suspend` the start is unknown and the evidence is a
 * zero-length epoch at the resume time, which other sources may widen.
 */
export function applyDesktopHint(
  state: DesktopHintState,
  hint: DesktopLifecycleHint,
): DesktopHintResult {
  if (state.lastSequence !== null && hint.sequence <= state.lastSequence) {
    return { state, evidence: null, networkOnline: false };
  }
  const base = { ...state, lastSequence: hint.sequence };
  const online = hint.online ?? state.online;
  switch (hint.kind) {
    case "suspend":
      return {
        state: { ...base, pendingSuspendAtMs: hint.occurredAt, online },
        evidence: null,
        networkOnline: false,
      };
    case "resume": {
      const suspendAtMs = state.pendingSuspendAtMs;
      const fresh =
        suspendAtMs !== null && hint.occurredAt - suspendAtMs <= DESKTOP_PENDING_SUSPEND_MAX_AGE_MS;
      return {
        state: { ...base, pendingSuspendAtMs: null, online },
        evidence: {
          source: "desktop-hint",
          startedAtMs: fresh ? suspendAtMs : hint.occurredAt,
          endedAtMs: hint.occurredAt,
        },
        networkOnline: hint.online === true,
      };
    }
    case "online":
      return { state: { ...base, online: true }, evidence: null, networkOnline: true };
    case "offline":
      return { state: { ...base, online: false }, evidence: null, networkOnline: false };
  }
}

/**
 * Measured evidence (gap detector, supervisor clock) uses up a pending suspend that came
 * before the sleep ended. A suspend just before the measured start announced this sleep and
 * widens the evidence to it. An older one was aborted or its resume was missed: the server
 * ran after it, so it starts nothing.
 */
export function consumePendingSuspend(
  state: DesktopHintState,
  evidence: SleepEvidence,
): { readonly state: DesktopHintState; readonly evidence: SleepEvidence } {
  const suspendAtMs = state.pendingSuspendAtMs;
  if (suspendAtMs === null || suspendAtMs > evidence.endedAtMs) return { state, evidence };
  const announced =
    suspendAtMs < evidence.startedAtMs &&
    evidence.startedAtMs - suspendAtMs <= SLEEP_EPOCH_MERGE_WINDOW_MS;
  return {
    state: { ...state, pendingSuspendAtMs: null },
    evidence: announced ? { ...evidence, startedAtMs: suspendAtMs } : evidence,
  };
}

// ── Supervisor suspended-time clock ──────────────────────────────────

/** A jump of at least this much suspended time between two heartbeats is a sleep. */
export const SUPERVISOR_SUSPENDED_JUMP_MS = 15_000;

export interface SupervisorClockState {
  readonly suspendedMillis: number;
}

export interface SupervisorClockResult {
  readonly state: SupervisorClockState | null;
  readonly evidence: SleepEvidence | null;
}

/**
 * Compares the supervisor's total suspended time with the previous heartbeat's. The clock
 * counts only real suspension, so a wall-clock change never opens an epoch. Zero means the
 * platform clock is unavailable; a decrease means a new supervisor process, which resets the
 * baseline.
 */
export function observeSupervisorSuspendedMillis(
  state: SupervisorClockState | null,
  suspendedMillis: number,
  observedAtMs: number,
): SupervisorClockResult {
  if (!Number.isFinite(suspendedMillis) || suspendedMillis <= 0) {
    return { state, evidence: null };
  }
  const next = { suspendedMillis };
  if (state === null || suspendedMillis < state.suspendedMillis) {
    return { state: next, evidence: null };
  }
  const jumpMs = suspendedMillis - state.suspendedMillis;
  if (jumpMs < SUPERVISOR_SUSPENDED_JUMP_MS) return { state: next, evidence: null };
  return {
    state: next,
    evidence: {
      source: "supervisor-clock",
      startedAtMs: observedAtMs - jumpMs,
      endedAtMs: observedAtMs,
    },
  };
}
