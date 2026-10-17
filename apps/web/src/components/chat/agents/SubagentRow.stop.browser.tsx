import "../../../index.css";

import { RuntimeTaskId, type OrchestrationTask } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { toastManager } from "../../ui/toast";
import { SubagentsCard } from "./SubagentsCard";

const agent = (id: string, overrides: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id: RuntimeTaskId.makeUnsafe(`claudeAgent:thread:1:${id}`),
  kind: "providerSubagent",
  nativeId: id,
  activityFresh: true,
  status: "inProgress",
  subject: `Subject ${id}`,
  source: "observed",
  freshness: { sessionEpoch: "1", sourcePriority: 1, observedOrdinal: 1 },
  createdAt: "2026-10-16T08:00:00.000Z",
  updatedAt: "2026-10-16T08:00:10.000Z",
  ...overrides,
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const NOW = "2026-10-16T08:01:00.000Z";

describe("per-subagent Stop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("stops one running subagent and stays disabled while the request is pending", async () => {
    const request = deferred();
    const onStop = vi.fn(() => request.promise);
    await render(<SubagentsCard agents={[agent("a")]} nowIso={NOW} onStopSubagent={onStop} />);
    const stop = page.getByRole("button", { name: "Stop Subject a" });
    await expect.element(stop).toBeEnabled();
    await stop.click();
    expect(onStop).toHaveBeenCalledWith(expect.objectContaining({ nativeId: "a" }));
    await expect.element(stop).toBeDisabled();
    // No optimistic state: the row keeps the server-reported status.
    expect(document.body.textContent).toContain("Working");
    request.resolve();
    await expect.element(stop).toBeEnabled();
  });

  it("shows a red error toast and re-enables Stop when the request fails", async () => {
    const add = vi.spyOn(toastManager, "add");
    const onStop = vi.fn(() => Promise.reject(new Error("That subagent is not running.")));
    await render(<SubagentsCard agents={[agent("a")]} nowIso={NOW} onStopSubagent={onStop} />);
    const stop = page.getByRole("button", { name: "Stop Subject a" });
    await stop.click();
    await expect.element(stop).toBeEnabled();
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "That subagent is not running." }),
    );
  });

  it("offers Stop only for fresh running rows of a provider that supports it", async () => {
    const onStop = vi.fn(() => Promise.resolve());
    const agents = [
      agent("done", { status: "completed" }),
      agent("stale", { activityFresh: false }),
      agent("noid", { nativeId: undefined }),
    ];
    await render(<SubagentsCard agents={agents} nowIso={NOW} onStopSubagent={onStop} />);
    await page.getByRole("button", { name: /Show 2 more/ }).click();
    expect(document.querySelectorAll("[data-subagent-stop]")).toHaveLength(0);
    document.body.innerHTML = "";
    await render(<SubagentsCard agents={[agent("a")]} nowIso={NOW} />);
    expect(document.querySelectorAll("[data-subagent-stop]")).toHaveLength(0);
  });
});
