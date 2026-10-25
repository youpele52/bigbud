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
    expect(document.body.textContent).toContain("working");
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

  it("leads the row in place of the agent icon and keeps the row collapsed when clicked", async () => {
    const onStop = vi.fn(() => Promise.resolve());
    await render(
      <SubagentsCard
        agents={[agent("a", { model: "claude-opus-5-5", lastToolName: "Bash" })]}
        nowIso={NOW}
        onStopSubagent={onStop}
      />,
    );
    const row = document.querySelector<HTMLElement>('[data-subagent-row="claudeAgent:thread:1:a"]');
    const stop = row?.querySelector<HTMLElement>("[data-subagent-stop]");
    const name = row?.querySelector<HTMLElement>("[data-subagent-name]");
    expect(stop).toBeTruthy();
    expect(
      row?.querySelector("[data-subagent-leading]")?.getAttribute("data-subagent-leading"),
    ).toBe("stop");
    // Leading slot: Stop sits left of the name, ahead of the model chip.
    expect(stop!.getBoundingClientRect().right).toBeLessThanOrEqual(
      name!.getBoundingClientRect().left,
    );
    const toggle = page.getByRole("button", { name: "Details for Subject a" });
    await page.getByRole("button", { name: "Stop Subject a" }).click();
    expect(onStop).toHaveBeenCalledTimes(1);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("turns red and explains itself in a tooltip on hover", async () => {
    const screen = await render(
      <SubagentsCard agents={[agent("a")]} nowIso={NOW} onStopSubagent={() => Promise.resolve()} />,
    );
    const stop = page.getByRole("button", { name: "Stop Subject a" });
    await expect.element(stop).toHaveClass(/hover:text-red-600/);
    await expect.element(stop).toHaveClass(/\[:hover,\[data-pressed\]\]:bg-red-500\/10/);
    // The ghost variant's accent hover background is replaced, not stacked under red.
    await expect.element(stop).not.toHaveClass(/\[:hover,\[data-pressed\]\]:bg-accent/);
    await stop.hover();
    await expect.element(page.getByText("Stop Subject a", { exact: true })).toBeVisible();
    // Unmount through React so the tooltip portal is removed before the body is cleared.
    await screen.unmount();
  });

  it("aligns names: rows that cannot be stopped keep the agent icon in the same slot", async () => {
    await render(
      <SubagentsCard
        agents={[agent("a"), agent("done", { status: "completed" })]}
        nowIso={NOW}
        onStopSubagent={() => Promise.resolve()}
      />,
    );
    await page.getByRole("button", { name: /Show 1 more/ }).click();
    const names = [...document.querySelectorAll<HTMLElement>("[data-subagent-name]")];
    expect(names).toHaveLength(2);
    expect(names[0]!.getBoundingClientRect().left).toBe(names[1]!.getBoundingClientRect().left);
    const doneRow = document.querySelector('[data-subagent-row="claudeAgent:thread:1:done"]');
    expect(
      doneRow?.querySelector("[data-subagent-leading]")?.getAttribute("data-subagent-leading"),
    ).toBe("icon");
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
