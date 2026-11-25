import "../../../index.css";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ComposerPromptQueue } from "./ComposerPromptQueue";

it("explains a manual-recovery hold, blocks release, and lets the user remove it", async () => {
  const remove = vi.fn();
  await render(
    <ComposerPromptQueue
      queuedPrompts={[
        {
          id: "manual-hold",
          text: "Original chat",
          createdAt: "2026-11-23T00:00:00.000Z",
          alreadySent: true,
          pendingInteractionGate: { manualRecovery: "discard-and-resend" },
        },
      ]}
      canSendNow
      onRemovePrompt={remove}
      onInterruptAndFlush={vi.fn()}
      canSteer
      onSteer={vi.fn()}
      controlOperation={null}
    />,
  );
  await expect.element(page.getByText("Held: Original chat")).toBeVisible();
  await expect.element(page.getByRole("status")).toHaveTextContent("was held before delivery");
  await expect.element(page.getByRole("button", { name: "Stop & send" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Steer" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Discard queued prompt 1" }).click();
  expect(remove).toHaveBeenCalledExactlyOnceWith("manual-hold");
});
