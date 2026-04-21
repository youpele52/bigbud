import { DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { createChatViewBrowserTestContext } from "./context";
import { DEFAULT_VIEWPORT, THREAD_ID, createSnapshotForTargetUser } from "./fixtures";
import { waitForElement } from "./dom";
import { createSnapshotWithLongProposedPlan } from "./scenarioFixtures";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

describe("ChatView archive and plan integration", () => {
  it("shows a pointer cursor for the running stop button", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-stop-button-cursor" as never,
        targetText: "stop button cursor target",
        sessionStatus: "running",
      }),
    });

    try {
      const stopButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        "Unable to find stop generation button.",
      );
      expect(getComputedStyle(stopButton).cursor).toBe("pointer");
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the archive action when the pointer leaves a thread row", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-archive-hover-test" as never,
        targetText: "archive hover target",
      }),
    });

    try {
      const threadRow = page.getByTestId(`thread-row-${THREAD_ID}`);
      await expect.element(threadRow).toBeInTheDocument();
      const archiveButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>(`[data-testid="thread-archive-${THREAD_ID}"]`),
        "Unable to find archive button.",
      );
      const archiveAction = archiveButton.parentElement;
      expect(archiveAction).not.toBeNull();
      expect(getComputedStyle(archiveAction!).opacity).toBe("0");

      await threadRow.hover();
      await vi.waitFor(() => {
        expect(getComputedStyle(archiveAction!).opacity).toBe("1");
      });

      await page.getByTestId("composer-editor").hover();
      await vi.waitFor(() => {
        expect(getComputedStyle(archiveAction!).opacity).toBe("0");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows the confirm archive action after clicking the archive button", async () => {
    localStorage.setItem(
      "bigbud:client-settings:v1",
      JSON.stringify({ ...DEFAULT_CLIENT_SETTINGS, confirmThreadArchive: true }),
    );

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-archive-confirm-test" as never,
        targetText: "archive confirm target",
      }),
    });

    try {
      const threadRow = page.getByTestId(`thread-row-${THREAD_ID}`);
      await expect.element(threadRow).toBeInTheDocument();
      await threadRow.hover();
      const archiveButton = page.getByTestId(`thread-archive-${THREAD_ID}`);
      await expect.element(archiveButton).toBeInTheDocument();
      await archiveButton.click();

      const confirmButton = page.getByTestId(`thread-archive-confirm-${THREAD_ID}`);
      await expect.element(confirmButton).toBeInTheDocument();
      await expect.element(confirmButton).toBeVisible();
    } finally {
      localStorage.removeItem("bigbud:client-settings:v1");
      await mounted.cleanup();
    }
  });

  it("keeps long proposed plans lightweight until the user expands them", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      const expandButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );

      expect(document.body.textContent).not.toContain("deep hidden detail only after expand");
      expandButton.click();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("deep hidden detail only after expand");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
