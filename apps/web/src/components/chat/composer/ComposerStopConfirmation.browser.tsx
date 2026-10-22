import "../../../index.css";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

afterEach(() => {
  document.body.innerHTML = "";
});

const renderStop = (input: { isRunning: boolean; backgroundSubagentCount: number }) => {
  const onInterrupt = vi.fn();
  const view = render(
    <ComposerPrimaryActions
      compact={false}
      pendingAction={null}
      isRunning={input.isRunning}
      hasBackgroundWork={input.backgroundSubagentCount > 0}
      backgroundSubagentCount={input.backgroundSubagentCount}
      showPlanFollowUpPrompt={false}
      promptHasText={false}
      isSendBusy={false}
      isConnecting={false}
      isPreparingWorktree={false}
      hasSendableContent={false}
      onPreviousPendingQuestion={() => {}}
      onInterrupt={onInterrupt}
      onImplementPlanInNewThread={() => {}}
    />,
  );
  return { onInterrupt, view };
};

it("stops immediately when no background subagent is running", async () => {
  const { onInterrupt, view } = renderStop({ isRunning: true, backgroundSubagentCount: 0 });
  await view;
  await page.getByRole("button", { name: "Stop generation" }).click();
  expect(onInterrupt).toHaveBeenCalledOnce();
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
});

it("asks before stopping background subagents, and Keep running cancels", async () => {
  const { onInterrupt, view } = renderStop({ isRunning: true, backgroundSubagentCount: 2 });
  await view;
  await page.getByRole("button", { name: "Stop generation and subagents" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByText("Stop this thread?")).toBeVisible();
  await expect
    .element(dialog.getByText(/This also stops its 2 background subagents\./))
    .toBeVisible();
  await dialog.getByRole("button", { name: "Keep running" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(onInterrupt).not.toHaveBeenCalled();
});

it("Stop all stops the thread while the root turn is idle", async () => {
  const { onInterrupt, view } = renderStop({ isRunning: false, backgroundSubagentCount: 1 });
  await view;
  await page.getByRole("button", { name: "Stop generation and subagents" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect
    .element(dialog.getByText(/This also stops its 1 background subagent\./))
    .toBeVisible();
  await dialog.getByRole("button", { name: "Stop all" }).click();
  expect(onInterrupt).toHaveBeenCalledOnce();
  await expect.element(dialog).not.toBeInTheDocument();
});
