import "../../../index.css";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { hasOwnedV2DescendantWork } from "../view/ChatView.subagents.logic";

afterEach(() => {
  document.body.innerHTML = "";
});

it.each([false, true])(
  "idle cardless retained-family Stop survives recovery uncertainty and pending question=%s",
  async (question) => {
    const onInterrupt = vi.fn();
    const retained = hasOwnedV2DescendantWork({
      session: {
        provider: "opencodeV2",
        retainedFamily: true,
        status: "ready",
        orchestrationStatus: "ready",
        createdAt: "2026-10-21T00:00:00Z",
        updatedAt: "2026-10-21T00:00:00Z",
      },
      providerAgents: [],
    });
    await render(
      <ComposerPrimaryActions
        compact={false}
        isRunning={false}
        hasBackgroundWork={retained}
        pendingAction={
          question
            ? {
                questionIndex: 0,
                isLastQuestion: true,
                canAdvance: false,
                isResponding: false,
                isComplete: false,
              }
            : null
        }
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
    await page.getByRole("button", { name: "Stop generation and subagents" }).click();
    expect(onInterrupt).toHaveBeenCalledOnce();
  },
);

it("main Stop remains keyboard-accessible while the main turn is idle and a native child is running", async () => {
  const onInterrupt = vi.fn();
  await render(
    <ComposerPrimaryActions
      compact={false}
      pendingAction={null}
      isRunning={false}
      hasBackgroundWork
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
  const stop = page.getByRole("button", { name: "Stop generation and subagents" });
  await expect.element(stop).toBeEnabled();
  await stop.click();
  expect(onInterrupt).toHaveBeenCalledOnce();
  expect(stop.element().getAttribute("tabindex")).not.toBe("-1");
});

it("main Stop is not hidden by a pending child question", async () => {
  const onInterrupt = vi.fn();
  await render(
    <ComposerPrimaryActions
      compact
      pendingAction={{
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      }}
      isRunning={false}
      hasBackgroundWork
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
  await expect.element(page.getByRole("button", { name: "Submit", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Stop generation and subagents" }).click();
  expect(onInterrupt).toHaveBeenCalledOnce();
});
