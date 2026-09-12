import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { getWsConnectionStatus, type WsConnectionStatus } from "~/rpc/wsConnectionState";

const mocks = vi.hoisted(() => ({ status: null as WsConnectionStatus | null }));
vi.mock("~/rpc/wsConnectionState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/rpc/wsConnectionState")>();
  return { ...actual, useWsConnectionStatus: () => mocks.status };
});
import { WorkingIndicator } from "./WorkingIndicator";

const indicator = () => (
  <WorkingIndicator verb="Thinking" activeWorkStartedAt={null} nowIso="2026-09-12T12:00:00Z" />
);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("WorkingIndicator reconnect status", () => {
  it("replaces verbs during retries, updates the count, and restores them on recovery", async () => {
    mocks.status = {
      ...getWsConnectionStatus(),
      hasConnected: true,
      phase: "disconnected",
      reconnectPhase: "waiting",
      reconnectAttemptCount: 4,
      reconnectMaxAttempts: 8,
    };
    const screen = await render(indicator());
    await expect.element(screen.getByRole("status")).toHaveTextContent("Reconnecting 4/8");
    expect(document.querySelector(".lucide-wifi.text-warning")).not.toBeNull();
    expect(document.querySelector(".shimmer")).toBeNull();
    expect(document.querySelector(".animate-pulse")).toBeNull();
    mocks.status = { ...mocks.status, reconnectPhase: "attempting", reconnectAttemptCount: 5 };
    await screen.rerender(indicator());
    await expect.element(screen.getByRole("status")).toHaveTextContent("Reconnecting 5/8");
    mocks.status = { ...mocks.status, phase: "connected", reconnectPhase: "idle" };
    await screen.rerender(indicator());
    await expect.element(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(document.querySelector(".lucide-wifi")).toBeNull();
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });

  it.each([
    { hasConnected: false, reconnectPhase: "attempting" as const },
    { online: false },
    { reconnectPhase: "exhausted" as const },
  ])(
    "does not label startup, offline, or exhausted states as active retries: %j",
    async (override) => {
      mocks.status = {
        ...getWsConnectionStatus(),
        hasConnected: true,
        phase: "disconnected",
        reconnectPhase: "waiting",
        ...override,
      };
      const screen = await render(indicator());
      await expect.element(screen.getByRole("status")).toHaveTextContent("Thinking");
      expect(document.querySelector(".lucide-wifi")).toBeNull();
    },
  );
});
