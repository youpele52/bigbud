import "../../index.css";

import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SshLegacyDrainDialog } from "./SshLegacyDrainDialog";
import type { SshLegacyDrainFlow, SshLegacyDrainPane } from "./SshLegacyDrainDialog.types";

const pane = (suffix: string): SshLegacyDrainPane => ({
  paneId: `pane-${suffix}`,
  threadId: `thread-${suffix}`,
  threadTitle: `Thread ${suffix}`,
  paneTitle: `Terminal ${suffix}`,
  route: `builder@host-${suffix}`,
});

/** A controlled flow that records every action and re-renders like a transport would. */
function harness(initial: Partial<SshLegacyDrainFlow> = {}) {
  const calls: string[] = [];
  let screen: Awaited<ReturnType<typeof render>>;
  let flow: SshLegacyDrainFlow = {
    phase: "review",
    panes: [pane("one"), pane("two")],
    saveAndClose: vi.fn(() => calls.push("save-and-close")),
    drainNow: vi.fn(() => calls.push("drain-now")),
    cancel: vi.fn(() => {
      calls.push("cancel");
      flow = { ...flow, phase: "closed" };
      void screen.rerender(<SshLegacyDrainDialog flow={flow} />);
    }),
    retry: vi.fn(() => calls.push("retry")),
    ...initial,
  };
  const show = async () => {
    screen = await render(<SshLegacyDrainDialog flow={flow} />);
    return screen;
  };
  const replace = async (next: Partial<SshLegacyDrainFlow>) => {
    flow = { ...flow, ...next };
    await screen.rerender(<SshLegacyDrainDialog flow={flow} />);
  };
  return {
    calls,
    show,
    replace,
    get flow() {
      return flow;
    },
  };
}

describe("SSH drain consent dialog", () => {
  it("lists thread and pane identity for the recorded set", async () => {
    const view = harness();
    const screen = await view.show();
    await expect
      .element(screen.getByText("SSH terminals must close for this upgrade"))
      .toBeVisible();
    const panes = screen.getByRole("list", { name: "Affected panes" });
    await expect.element(panes).toBeVisible();
    await expect.element(screen.getByText("Thread one")).toBeVisible();
    await expect.element(screen.getByText("Terminal two")).toBeVisible();
    await expect.element(screen.getByText("builder@host-two")).toBeVisible();
    expect(view.calls).toEqual([]);
  });

  it("Cancel blocks the upgrade without draining or retrying", async () => {
    const view = harness();
    const screen = await view.show();
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(view.calls).toEqual(["cancel"]);
    expect(view.flow.saveAndClose).not.toHaveBeenCalled();
    expect(view.flow.drainNow).not.toHaveBeenCalled();
    expect(view.flow.retry).not.toHaveBeenCalled();
    await expect
      .element(screen.getByText("SSH terminals must close for this upgrade"))
      .not.toBeInTheDocument();
  });

  it.each([
    ["Save and close", "save-and-close"],
    ["Drain now", "drain-now"],
  ] as const)("%s proceeds with the current recorded set only", async (label, action) => {
    const view = harness();
    const screen = await view.show();
    await screen.getByRole("button", { name: label }).click();
    expect(view.calls).toEqual([action]);
    expect(view.flow.panes).toHaveLength(2);
    expect(view.flow.cancel).not.toHaveBeenCalled();
  });

  it("retry after an error re-lists panes and can still cancel", async () => {
    const view = harness({ phase: "error", error: "The terminal host did not answer." });
    const screen = await view.show();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("The terminal host did not answer.");
    await screen.getByRole("button", { name: "Retry" }).click();
    expect(view.calls).toEqual(["retry"]);
    await view.replace({ phase: "review", panes: [pane("three")] });
    await expect.element(screen.getByText("Thread three")).toBeVisible();
    await screen.getByRole("button", { name: "Cancel" }).click();
    expect(view.calls).toEqual(["retry", "cancel"]);
  });

  it("offers the explicit drain action and no upgrade wording on a startup refusal", async () => {
    const view = harness({ reason: "startup-refusal" });
    const screen = await view.show();
    await expect
      .element(screen.getByText("SSH is unavailable until the previous terminals drain"))
      .toBeVisible();
    await screen.getByRole("button", { name: "Drain identified panes" }).click();
    expect(view.calls).toEqual(["drain-now"]);
  });

  it("disables every action while the drain is submitting", async () => {
    const view = harness({ phase: "submitting" });
    const screen = await view.show();
    for (const label of ["Cancel", "Save and close", "Drain now"]) {
      await expect.element(screen.getByRole("button", { name: label })).toBeDisabled();
    }
    expect(view.calls).toEqual([]);
  });
});
