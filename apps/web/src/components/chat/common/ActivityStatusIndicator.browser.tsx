import "~/index.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { getWsConnectionStatus, type WsConnectionStatus } from "~/rpc/wsConnectionState";

const mocks = vi.hoisted(() => ({ status: null as WsConnectionStatus | null }));
vi.mock("~/rpc/wsConnectionState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/rpc/wsConnectionState")>();
  return { ...actual, useWsConnectionStatus: () => mocks.status };
});
import { ActivityStatusIndicator } from "./ActivityStatusIndicator";
import { isSessionCompacting } from "./threadActivityIndicator";

const indicator = (isCompacting = false) => (
  <ActivityStatusIndicator
    verb="Thinking"
    isCompacting={isCompacting}
    activeWorkStartedAt={null}
    nowIso="2026-09-12T12:00:00Z"
  />
);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ActivityStatusIndicator reconnect status", () => {
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
    expect(document.querySelector(".text-warning .lucide-wifi")).not.toBeNull();
    const reconnectingShimmer = document.querySelector<HTMLElement>(".shimmer");
    expect(reconnectingShimmer).not.toBeNull();
    expect(reconnectingShimmer && getComputedStyle(reconnectingShimmer).animationName).toBe(
      "web-shimmer",
    );
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
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

it("prioritizes reconnecting over compaction and restores the provider activity after recovery", async () => {
  mocks.status = { ...getWsConnectionStatus(), hasConnected: true, phase: "connected" };
  const screen = await render(indicator(true));
  await expect.element(screen.getByRole("status")).toHaveTextContent("Compacting");
  expect(document.querySelector(".text-warning")?.textContent).toBe("Compacting");
  const compactingShimmer = document.querySelector<HTMLElement>(".shimmer");
  expect(compactingShimmer).not.toBeNull();
  expect(compactingShimmer && getComputedStyle(compactingShimmer).animationName).toBe(
    "web-shimmer",
  );

  mocks.status = {
    ...mocks.status,
    phase: "disconnected",
    reconnectPhase: "waiting",
    reconnectAttemptCount: 2,
  };
  await screen.rerender(indicator(true));
  await expect.element(screen.getByRole("status")).toHaveTextContent("Reconnecting 2/8");
  expect(document.querySelector(".text-warning")?.textContent).toBe("Reconnecting 2/8");

  mocks.status = { ...mocks.status, phase: "connected", reconnectPhase: "idle" };
  await screen.rerender(indicator(true));
  await expect.element(screen.getByRole("status")).toHaveTextContent("Compacting");
  await screen.rerender(indicator(false));
  await expect.element(screen.getByRole("status")).toHaveTextContent("Thinking");
  expect(document.querySelector(".text-warning")).toBeNull();
});

it("keeps elapsed time alongside compaction status", async () => {
  mocks.status = { ...getWsConnectionStatus(), phase: "connected" };
  const screen = await render(
    <ActivityStatusIndicator
      verb="Thinking"
      isCompacting
      activeWorkStartedAt="2026-09-12T12:00:00Z"
      nowIso="2026-09-12T12:01:00Z"
    />,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("Compacting");
  await expect.element(screen.getByRole("status")).toHaveTextContent("1m");
});

it("renders the secondary memory label without foreground elapsed time", async () => {
  mocks.status = { ...getWsConnectionStatus(), phase: "connected" };
  const screen = await render(
    <ActivityStatusIndicator
      verb="Reviewing memory"
      isCompacting={false}
      activeWorkStartedAt={null}
      nowIso="2026-09-13T12:04:00Z"
    />,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("Reviewing memory");
  await expect.element(screen.getByRole("status")).not.toHaveTextContent("0s");
});

it.each([
  { orchestrationStatus: "running", reason: "status:active" },
  { orchestrationStatus: "ready", reason: "context.compacting" },
  { orchestrationStatus: "error", reason: "context.compacting" },
  { orchestrationStatus: "stopped", reason: "context.compacting" },
  null,
])("clears compaction when the provider session leaves compaction: %j", async (session) => {
  mocks.status = { ...getWsConnectionStatus(), phase: "connected" };
  const screen = await render(
    indicator(
      isSessionCompacting({ orchestrationStatus: "running", reason: "context.compacting" }),
    ),
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("Compacting");
  await screen.rerender(indicator(isSessionCompacting(session)));
  await expect.element(screen.getByRole("status")).toHaveTextContent("Thinking");
});
