import "~/index.css";

import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { useEffect, useState } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { makeActivity } from "~/logic/session/session.logic.test.helpers";
import { getWsConnectionStatus, type WsConnectionStatus } from "~/rpc/wsConnectionState";

const mocks = vi.hoisted(() => ({ status: null as WsConnectionStatus | null }));
vi.mock("~/rpc/wsConnectionState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/rpc/wsConnectionState")>();
  return { ...actual, useWsConnectionStatus: () => mocks.status };
});

import { useMemoryReviewStatus } from "./memoryReviewStatus.hooks";

const STARTED_AT = "2026-09-13T12:00:00.000Z";

function startedActivity(
  jobId: string,
  expiresAt: string,
  sequence = 1,
): OrchestrationThreadActivity {
  return makeActivity({
    id: `memory-start-${jobId}`,
    sequence,
    createdAt: STARTED_AT,
    kind: "learning.memory.started",
    tone: "info",
    summary: "Reviewing memory",
    payload: { jobId, attempt: 1, expiresAt },
  });
}

function MemoryReviewHarness({
  activities,
}: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  const [foregroundNowTick, setForegroundNowTick] = useState(() => Date.now());
  const isWorking = false;
  useEffect(() => {
    if (!isWorking) return;
    const timer = window.setInterval(() => setForegroundNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [isWorking]);
  const visible = useMemoryReviewStatus(activities);
  return (
    <output
      data-testid="memory-state"
      data-foreground-now-tick={new Date(foregroundNowTick).toISOString()}
      data-is-working={String(isWorking)}
    >
      {visible ? "visible" : "hidden"}
    </output>
  );
}

function connectedStatus(): WsConnectionStatus {
  return {
    ...getWsConnectionStatus(),
    hasConnected: true,
    phase: "connected",
    reconnectPhase: "idle",
  };
}

describe("useMemoryReviewStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(STARTED_AT));
    mocks.status = connectedStatus();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("expires from its own timer while the foreground clock stays stopped", async () => {
    const screen = await render(
      <MemoryReviewHarness
        activities={[startedActivity("job-expiry", "2026-09-13T12:01:00.000Z")]}
      />,
    );

    expect(page.getByTestId("memory-state").element().textContent).toBe("visible");
    await vi.advanceTimersByTimeAsync(60_000);
    await expect.element(screen.getByTestId("memory-state")).toHaveTextContent("hidden");
    expect(page.getByTestId("memory-state").element().dataset.foregroundNowTick).toBe(STARTED_AT);
    expect(page.getByTestId("memory-state").element().dataset.isWorking).toBe("false");
  });

  it("requires a connected socket that is not actively reconnecting", async () => {
    const activities = [startedActivity("job-connection", "2026-09-13T12:01:00.000Z")];
    const screen = await render(<MemoryReviewHarness activities={activities} />);
    await expect.element(screen.getByTestId("memory-state")).toHaveTextContent("visible");

    mocks.status = {
      ...mocks.status!,
      phase: "disconnected",
      reconnectPhase: "waiting",
    };
    await screen.rerender(<MemoryReviewHarness activities={activities} />);
    await expect.element(screen.getByTestId("memory-state")).toHaveTextContent("hidden");

    mocks.status = connectedStatus();
    await screen.rerender(<MemoryReviewHarness activities={activities} />);
    await expect.element(screen.getByTestId("memory-state")).toHaveTextContent("visible");
  });

  it("clears the expiry timeout when the attempt changes and when it unmounts", async () => {
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    const screen = await render(
      <MemoryReviewHarness
        activities={[startedActivity("job-first", "2026-09-13T12:01:00.000Z")]}
      />,
    );
    const callsAfterMount = clearTimeoutSpy.mock.calls.length;

    await screen.rerender(
      <MemoryReviewHarness
        activities={[startedActivity("job-second", "2026-09-13T12:03:00.000Z")]}
      />,
    );
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);

    const callsAfterIdentityChange = clearTimeoutSpy.mock.calls.length;
    await screen.unmount();
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(callsAfterIdentityChange);
  });
});
