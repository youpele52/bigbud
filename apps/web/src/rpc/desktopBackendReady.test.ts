import { describe, expect, it, vi } from "vitest";
import type { DesktopBackendStartupState } from "@bigbud/contracts/server/ipc.desktop.ts";

import { DesktopBackendStartupError, waitForDesktopBackendReady } from "./desktopBackendReady";

function state(status: DesktopBackendStartupState["status"], generation = 1) {
  return { generation, startedAt: 1, status } satisfies DesktopBackendStartupState;
}

describe("desktop backend readiness", () => {
  it("does not delay browser connections without the desktop bridge", async () => {
    await expect(waitForDesktopBackendReady(undefined)).resolves.toBeUndefined();
  });

  it("resolves immediately and unsubscribes when the backend is already ready", async () => {
    const unsubscribe = vi.fn();
    const onBackendStartupState = vi.fn(() => unsubscribe);

    await expect(
      waitForDesktopBackendReady({
        getBackendStartupState: async () => state("ready"),
        onBackendStartupState,
      }),
    ).resolves.toBeUndefined();

    expect(onBackendStartupState).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects a failed startup without waiting for a socket attempt", async () => {
    const unsubscribe = vi.fn();

    await expect(
      waitForDesktopBackendReady({
        getBackendStartupState: async () => ({
          ...state("failed"),
          failureReason: "server_runtime_startup_failed",
        }),
        onBackendStartupState: () => unsubscribe,
      }),
    ).rejects.toBeInstanceOf(DesktopBackendStartupError);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("waits through a timeout until the same generation becomes ready", async () => {
    let listener: ((next: DesktopBackendStartupState) => void) | undefined;
    let resolved = false;
    const waiting = waitForDesktopBackendReady({
      getBackendStartupState: async () => state("timedOut"),
      onBackendStartupState: (next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    }).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    listener?.(state("ready"));
    await waiting;
    expect(resolved).toBe(true);
    expect(listener).toBeUndefined();
  });

  it("prefers a subscribed update over a stale initial-state response", async () => {
    let resolveInitial: ((state: DesktopBackendStartupState) => void) | undefined;
    let listener: ((next: DesktopBackendStartupState) => void) | undefined;
    const initial = new Promise<DesktopBackendStartupState>((resolve) => {
      resolveInitial = resolve;
    });
    const waiting = waitForDesktopBackendReady({
      getBackendStartupState: () => initial,
      onBackendStartupState: (next) => {
        listener = next;
        return () => undefined;
      },
    });

    listener?.(state("starting", 2));
    resolveInitial?.(state("failed", 1));
    await Promise.resolve();
    listener?.(state("ready", 2));
    await expect(waiting).resolves.toBeUndefined();
  });

  it("keeps the authoritative listener after the initial IPC read rejects", async () => {
    let listener: ((next: DesktopBackendStartupState) => void) | undefined;
    const waiting = waitForDesktopBackendReady({
      getBackendStartupState: async () => Promise.reject(new Error("IPC read failed")),
      onBackendStartupState: (next) => {
        listener = next;
        return () => undefined;
      },
    });

    await Promise.resolve();
    listener?.(state("ready"));
    await expect(waiting).resolves.toBeUndefined();
  });

  it("unsubscribes when a pending readiness wait is cancelled", async () => {
    const controller = new AbortController();
    const unsubscribe = vi.fn();
    const waiting = waitForDesktopBackendReady(
      {
        getBackendStartupState: async () => state("starting"),
        onBackendStartupState: () => unsubscribe,
      },
      controller.signal,
    );

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
