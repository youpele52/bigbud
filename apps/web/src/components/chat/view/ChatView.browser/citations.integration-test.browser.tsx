import { expect, it } from "vitest";
import { cdp, page } from "vitest/browser";

import { useComposerDraftStore } from "../../../../stores/composer/composer.store";
import { selectChatText } from "../../common/ChatCitation.browser.helpers";
import {
  chatPointerCoordinates,
  nativeDragChatRange,
} from "../../common/ChatCitation.browser.pointer";
import { createChatViewBrowserTestContext } from "./context";
import { waitForElement } from "./dom";
import { THREAD_ID, WIDE_FOOTER_VIEWPORT } from "./fixtures";
import { createSnapshotWithPendingUserInput } from "./scenarioFixtures";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

it.each(["word", "phrase", "whole-line"] as const)(
  "shows a cited question %s in the real pending-answer composer",
  async (mode) => {
    const mounted = await ctx.mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });
    try {
      await waitForElement(
        () =>
          document.querySelector<HTMLElement>(
            '[data-testid="composer-editor"][aria-placeholder="Type your answer to continue..."]',
          ),
        "Expected the pending-answer composer",
      );
      useComposerDraftStore.getState().addAnnotation(THREAD_ID, {
        id: "hidden-code-annotation",
        kind: "code",
        intent: "context",
        comment: "Do not show unrelated attachments while answering",
        createdAt: "2026-10-30T00:00:00.000Z",
        file: { cwd: "/repo/project", relativePath: "example.ts" },
        selection: { text: "const value = 1;", startLine: 1, endLine: 1 },
      });
      const question = page
        .getByText("What should this change cover?", { exact: true })
        .element() as HTMLElement;
      const selectedText = mode === "word" ? "What" : question.textContent!;
      if (mode === "whole-line") {
        const bounds = question.getBoundingClientRect();
        const point = chatPointerCoordinates(bounds.left + 20, bounds.top + bounds.height / 2);
        const mouse = cdp();
        await mouse.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await mouse.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...point,
          button: "left",
          clickCount: 3,
        });
        await mouse.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          ...point,
          button: "left",
          clickCount: 3,
        });
      } else {
        const range = selectChatText(question, 0, selectedText.length).getRangeAt(0).cloneRange();
        await nativeDragChatRange(range, false);
      }
      expect(window.getSelection()?.toString().trim()).toBe(selectedText);
      await page.getByRole("button", { name: "Cite", exact: true }).click();
      const form = document.querySelector<HTMLElement>('[data-chat-composer-form="true"]')!;
      await expect
        .poll(() => form.querySelector('[aria-label="Citations"]')?.textContent)
        .toContain(selectedText);
      await expect.element(page.getByRole("button", { name: "Remove citation 1" })).toBeVisible();
      expect(form.querySelector('[aria-label="Show 1 annotation"]')).toBeNull();
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.annotations,
      ).toMatchObject([
        { id: "hidden-code-annotation" },
        {
          source: { kind: "question", requestId: "req-browser-user-input", questionId: "scope" },
          selection: { text: expect.stringContaining(selectedText) },
        },
      ]);
      await page.getByRole("button", { name: "Remove citation 1" }).click();
      await expect.poll(() => form.querySelector('[aria-label="Citations"]')).toBeNull();
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.annotations,
      ).toMatchObject([{ id: "hidden-code-annotation" }]);
      expect(
        useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.annotations,
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  },
);
