import { afterEach, describe, expect, it, vi } from "vitest";

const windows = vi.hoisted(
  () =>
    [] as Array<{ isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }>,
);

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => windows } }));

import {
  beginBackendStartup,
  configureBackendStartupState,
  getBackendStartupState,
  recordBackendStartupFailure,
  recordBackendStartupStatus,
} from "./backendStartupState";

describe("backend startup state", () => {
  afterEach(() => vi.useRealTimers());

  it("ignores stale child status and accepts ready after the deadline", () => {
    vi.useFakeTimers();
    const first = beginBackendStartup(100);
    const second = beginBackendStartup(200);
    expect(recordBackendStartupStatus(first, "upgrading")).toBe(false);
    expect(getBackendStartupState()).toMatchObject({ generation: second, status: "starting" });

    vi.advanceTimersByTime(10 * 60 * 1_000);
    expect(getBackendStartupState().status).toBe("timedOut");
    expect(recordBackendStartupStatus(second, "ready")).toBe(true);
    expect(getBackendStartupState().status).toBe("ready");
  });

  it("returns transition acceptance for legal, unsupported, stale, and terminal statuses", () => {
    const stale = beginBackendStartup();
    const generation = beginBackendStartup();

    expect(recordBackendStartupStatus(stale, "ready")).toBe(false);
    expect(recordBackendStartupStatus(generation, "unsupported")).toBe(false);
    expect(recordBackendStartupStatus(generation, "upgrading")).toBe(true);
    expect(recordBackendStartupStatus(generation, "starting")).toBe(true);
    expect(recordBackendStartupStatus(generation, "error", "unknown")).toBe(true);
    expect(recordBackendStartupStatus(generation, "ready")).toBe(false);
    expect(recordBackendStartupStatus(generation, "error", "unknown")).toBe(false);
  });

  it("rejects timeout regressions while allowing only a late ready", () => {
    vi.useFakeTimers();
    const generation = beginBackendStartup();
    vi.advanceTimersByTime(10 * 60 * 1_000);
    expect(recordBackendStartupStatus(generation, "upgrading")).toBe(false);
    expect(recordBackendStartupStatus(generation, "starting")).toBe(false);
    expect(recordBackendStartupStatus(generation, "error")).toBe(false);
    expect(getBackendStartupState().status).toBe("timedOut");
    expect(recordBackendStartupStatus(generation, "ready")).toBe(true);
    expect(getBackendStartupState().status).toBe("ready");
    expect(recordBackendStartupStatus(generation, "upgrading")).toBe(false);
    expect(getBackendStartupState().status).toBe("ready");
  });

  it("clears the deadline after failure", () => {
    vi.useFakeTimers();
    const generation = beginBackendStartup();
    recordBackendStartupFailure(generation);
    vi.advanceTimersByTime(10 * 60 * 1_000);
    expect(getBackendStartupState().status).toBe("failed");
  });

  it("treats child failure as authoritative only for its generation", () => {
    const first = beginBackendStartup();
    const second = beginBackendStartup();
    recordBackendStartupFailure(first);
    expect(getBackendStartupState().status).toBe("starting");
    recordBackendStartupFailure(second);
    expect(getBackendStartupState().status).toBe("failed");
  });

  it("preserves the first failure reason, resets it for a new generation, and ignores post-ready exits", () => {
    const first = beginBackendStartup();
    recordBackendStartupFailure(first, "child_spawn_failed");
    recordBackendStartupFailure(first, "child_exit_before_ready");
    expect(getBackendStartupState().failureReason).toBe("child_spawn_failed");
    const second = beginBackendStartup();
    expect(getBackendStartupState().failureReason).toBeUndefined();
    recordBackendStartupStatus(second, "ready");
    recordBackendStartupFailure(second, "child_exit_before_ready");
    expect(getBackendStartupState()).toMatchObject({ generation: second, status: "ready" });
  });

  it("publishes development crash details only when development diagnostics are enabled", () => {
    configureBackendStartupState("desktop:backend-startup-state", true);
    const generation = beginBackendStartup();
    recordBackendStartupFailure(generation, "child_exit_before_ready", undefined, {
      capturedAt: "2026-01-01T00:00:00.000Z",
      stderrTail: "development stderr",
    });
    expect(getBackendStartupState().developmentDiagnostics?.stderrTail).toBe("development stderr");
    beginBackendStartup();
    expect(getBackendStartupState().developmentDiagnostics).toBeUndefined();
    configureBackendStartupState("desktop:backend-startup-state", false);
  });
});
