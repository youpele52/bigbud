import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { createChatViewBrowserTestContext } from "./context";
import { COMPACT_FOOTER_VIEWPORT, WIDE_FOOTER_VIEWPORT } from "./fixtures";
import {
  expectComposerActionsContained,
  findComposerProviderModelPicker,
  waitForButtonByText,
  waitForElement,
} from "./dom";
import {
  createSnapshotWithPendingUserInput,
  createSnapshotWithPlanFollowUpPrompt,
} from "./scenarioFixtures";

/** Offset from the footer's content edge, so responsive footer padding does not count as a shift. */
function footerContentOffset(footer: HTMLElement, element: HTMLElement): number {
  const paddingLeft = Number.parseFloat(getComputedStyle(footer).paddingLeft) || 0;
  return element.getBoundingClientRect().left - footer.getBoundingClientRect().left - paddingLeft;
}

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

describe("ChatView footer layout integration", () => {
  it("keeps pending-question footer actions inside the composer after a real resize", async () => {
    const mounted = await ctx.mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      // The question is shown in the timeline; the answer is typed into the composer and sent.
      await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-timeline-row-id="user-input-question:req-browser-user-input"]',
          ),
        "Unable to find the pending question.",
      );
      await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="composer-editor"][aria-placeholder="Type your answer to continue..."]',
          ),
        "Composer should ask for the answer.",
      );
      await page.getByTestId("composer-editor").fill("Tight");
      const send = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
        "Unable to find the send button.",
      );
      await vi.waitFor(() => expect(send.disabled).toBe(false));
      await mounted.setContainerSize(COMPACT_FOOTER_VIEWPORT);
      await expectComposerActionsContained();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps plan follow-up footer actions fused and aligned after a real resize", async () => {
    const mounted = await ctx.mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt(),
    });

    try {
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );
      const initialModelPicker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider model picker.",
      );
      const initialModelPickerOffset = footerContentOffset(footer, initialModelPicker);
      const initialImplementButton = await waitForButtonByText("Implement");
      const initialImplementWidth = initialImplementButton.getBoundingClientRect().width;

      await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      // A 440px window, as on a phone: the sidebar collapses, unlike a shrunken host in a wide window.
      const narrow = { ...WIDE_FOOTER_VIEWPORT, name: "narrow-footer", width: 440 };
      await mounted.setViewport(narrow);
      await mounted.setContainerSize(narrow);
      await expectComposerActionsContained();

      const implementButton = await waitForButtonByText("Implement");
      const implementActionsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await vi.waitFor(() => {
        const implementRect = implementButton.getBoundingClientRect();
        const implementActionsRect = implementActionsButton.getBoundingClientRect();
        const compactModelPicker = findComposerProviderModelPicker();
        expect(compactModelPicker).toBeTruthy();

        const compactModelPickerOffset = footerContentOffset(footer, compactModelPicker!);

        expect(Math.abs(implementRect.right - implementActionsRect.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(implementRect.top - implementActionsRect.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(implementRect.width - initialImplementWidth)).toBeLessThanOrEqual(1);
        expect(Math.abs(compactModelPickerOffset - initialModelPickerOffset)).toBeLessThanOrEqual(
          1,
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the wide desktop follow-up layout expanded when the footer still fits", async () => {
    const mounted = await ctx.mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt({
        modelSelection: { provider: "codex", model: "gpt-5.3-codex-spark" },
        planMarkdown:
          "# Imaginary Long-Range Plan: T3 Code Adaptive Orchestration and Safe-Delay Execution Initiative",
      }),
    });

    try {
      await waitForButtonByText("Implement");

      await vi.waitFor(
        () => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const actions = document.querySelector<HTMLElement>(
            '[data-chat-composer-actions="right"]',
          );

          expect(footer?.dataset.chatComposerFooterCompact).toBe("false");
          expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("false");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("compacts the footer when a wide desktop follow-up layout starts overflowing", async () => {
    const mounted = await ctx.mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt({
        modelSelection: { provider: "codex", model: "gpt-5.3-codex-spark" },
        planMarkdown:
          "# Imaginary Long-Range Plan: T3 Code Adaptive Orchestration and Safe-Delay Execution Initiative",
      }),
    });

    try {
      await waitForButtonByText("Implement");

      await mounted.setContainerSize({
        width: 804,
        height: WIDE_FOOTER_VIEWPORT.height,
      });

      await expectComposerActionsContained();

      await vi.waitFor(
        () => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const actions = document.querySelector<HTMLElement>(
            '[data-chat-composer-actions="right"]',
          );

          expect(footer?.dataset.chatComposerFooterCompact).toBe("true");
          expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("true");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
