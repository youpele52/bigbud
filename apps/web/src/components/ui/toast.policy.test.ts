import { describe, expect, it } from "vitest";
import {
  isConditionSuppressed,
  isProgressOutcome,
  resolveToastStoreTimeout,
  resolveVisibleAutoDismissMs,
  TOAST_CONDITION_COOLDOWN_MS,
  TOAST_DURATION_MS,
  toastSeverityDurationMs,
  toastSeverityRank,
} from "./toast.policy";

describe("toastSeverityDurationMs", () => {
  it("keys durations by severity", () => {
    expect(toastSeverityDurationMs("error")).toBe(15_000);
    expect(toastSeverityDurationMs("warning")).toBe(15_000);
    expect(toastSeverityDurationMs("success")).toBe(5_000);
    expect(toastSeverityDurationMs("info")).toBe(10_000);
    expect(toastSeverityDurationMs(undefined)).toBe(10_000);
    expect(toastSeverityDurationMs("custom")).toBe(10_000);
    expect(toastSeverityDurationMs("loading")).toBe(15_000);
  });
});

describe("resolveToastStoreTimeout", () => {
  it("uses the severity duration when none is given", () => {
    expect(resolveToastStoreTimeout("success", undefined)).toBe(5_000);
    expect(resolveToastStoreTimeout("error", undefined)).toBe(15_000);
  });

  it("raises shorter explicit durations and keeps longer ones", () => {
    expect(resolveToastStoreTimeout("error", 8_000)).toBe(15_000);
    expect(resolveToastStoreTimeout("success", 8_000)).toBe(8_000);
    expect(resolveToastStoreTimeout(undefined, 3_000)).toBe(10_000);
  });

  it("hands persistent and invalid timeouts to the visible-time countdown", () => {
    for (const timeout of [0, -1, Infinity, Number.NaN]) {
      expect(resolveToastStoreTimeout("warning", timeout)).toBe(0);
    }
  });
});

describe("resolveVisibleAutoDismissMs", () => {
  it("auto-dismisses persistent toasts after their severity duration", () => {
    expect(resolveVisibleAutoDismissMs({ type: "warning", timeout: 0 })).toBe(15_000);
    expect(resolveVisibleAutoDismissMs({ type: "success", timeout: 0, data: {} })).toBe(5_000);
    expect(resolveVisibleAutoDismissMs({ timeout: 0 })).toBe(10_000);
  });

  it("caps loading toasts, which Base UI never times out", () => {
    expect(resolveVisibleAutoDismissMs({ type: "loading", timeout: 5_000 })).toBe(
      TOAST_DURATION_MS.loading,
    );
  });

  it("keeps explicit visible durations only at or above the severity duration", () => {
    const success = (ms: number) =>
      resolveVisibleAutoDismissMs({
        type: "success",
        timeout: 0,
        data: { dismissAfterVisibleMs: ms },
      });
    expect(success(8_000)).toBe(8_000);
    expect(success(3_000)).toBe(5_000);
    expect(
      resolveVisibleAutoDismissMs({ type: "error", data: { dismissAfterVisibleMs: 8_000 } }),
    ).toBe(15_000);
  });

  it("leaves timed toasts to their store timer", () => {
    expect(resolveVisibleAutoDismissMs({ type: "success", timeout: 5_000 })).toBeUndefined();
    expect(resolveVisibleAutoDismissMs({ type: "info", timeout: 10_000 })).toBeUndefined();
  });
});

describe("condition suppression", () => {
  const dismissal = { dismissedAt: 1_000, severityRank: toastSeverityRank("warning") };

  it("suppresses the same or lower severity during the cool-down", () => {
    expect(isConditionSuppressed(dismissal, "warning", 1_001)).toBe(true);
    expect(isConditionSuppressed(dismissal, "info", 1_001)).toBe(true);
  });

  it("re-shows on severity escalation", () => {
    expect(isConditionSuppressed(dismissal, "error", 1_001)).toBe(false);
  });

  it("re-shows after the cool-down", () => {
    expect(isConditionSuppressed(dismissal, "warning", 1_000 + TOAST_CONDITION_COOLDOWN_MS)).toBe(
      false,
    );
  });

  it("never suppresses a condition nobody dismissed", () => {
    expect(isConditionSuppressed(undefined, "warning", 1_001)).toBe(false);
  });
});

describe("isProgressOutcome", () => {
  it("treats a loading toast turning into a result as an outcome", () => {
    expect(isProgressOutcome({ type: "loading" }, { type: "success" })).toBe(true);
    expect(isProgressOutcome({ type: "loading" }, { type: "error", timeout: 0 })).toBe(true);
    expect(isProgressOutcome({ type: "loading" }, { type: "loading" })).toBe(false);
    expect(isProgressOutcome({ type: "loading" }, {})).toBe(false);
  });

  it("treats a persistent toast turning into a timed result as an outcome", () => {
    expect(
      isProgressOutcome({ type: "warning", timeout: 0 }, { type: "success", timeout: 8_000 }),
    ).toBe(true);
    expect(isProgressOutcome({ type: "warning", timeout: 0 }, { type: "info" })).toBe(true);
  });

  it("does not treat ongoing or already-timed toasts as outcomes", () => {
    expect(
      isProgressOutcome({ type: "warning", timeout: 0 }, { type: "warning", timeout: 0 }),
    ).toBe(false);
    expect(isProgressOutcome({ type: "warning" }, { type: "error" })).toBe(false);
    expect(isProgressOutcome({ type: "success" }, { type: "success", timeout: 5_000 })).toBe(false);
  });
});
