import "../../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../../stores/composer/composer.store";
import { useSearchStore } from "../../../stores/ui/search.store";
import {
  CitationBrowserHarness,
  CITE_THREAD_ID,
  contentFor,
  selectChatText,
} from "./ChatCitation.browser.helpers";
import { nativeDragChatRange } from "./ChatCitation.browser.pointer";
import { createMessage } from "../messages/MessagesTimeline.virtualization.test.fixtures";
import { readChatCitationSelection } from "./ChatCitation.selection";

vi.mock("../../../rpc/serverState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../rpc/serverState")>()),
  useServerDiscoveredAgents: () => [],
  useServerDiscoveredSkills: () => [],
}));

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  useSearchStore.setState({ focusRequest: null });
  window.getSelection()?.removeAllRanges();
});
afterEach(() => window.getSelection()?.removeAllRanges());

it("cites prose spanning a fenced code block", async () => {
  const screen = await render(
    <CitationBrowserHarness
      messages={[
        createMessage({
          id: "code-example",
          role: "assistant",
          text: "Before the example.\n\n```ts\nconst value = 1;\n```\n\nAfter the example.",
          offsetSeconds: 0,
        }),
      ]}
    />,
  );
  try {
    const content = contentFor("code-example");
    const selection = selectChatText(content, 0, content.textContent!.length);
    const selectedText = selection.toString();
    expect(readChatCitationSelection(selection, document.body)).not.toBeNull();
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations[0],
    ).toMatchObject({ selection: { text: selectedText } });
  } finally {
    await screen.unmount();
  }
});

it.each([
  { messageId: "cite-user", backward: false },
  { messageId: "cite-user", backward: true },
  { messageId: "cite-assistant", backward: false },
  { messageId: "cite-assistant", backward: true },
])(
  "cites a native phrase drag in $messageId (backward: $backward)",
  async ({ messageId, backward }) => {
    const screen = await render(<CitationBrowserHarness />);
    try {
      const content = contentFor(messageId);
      content.style.width = "180px";
      const text = content.textContent!;
      const phrase = messageId === "cite-user" ? "this exact phrase" : "quoted phrase appears here";
      const start = text.indexOf(phrase);
      const range = selectChatText(content, start, start + phrase.length)
        .getRangeAt(0)
        .cloneRange();
      await nativeDragChatRange(range, backward, async () => {
        // The floating action must not intercept the in-progress text selection.
        await expect.poll(() => document.querySelector("[data-chat-cite-toolbar]")).toBeNull();
      });
      const selectedText = window.getSelection()?.toString();
      expect(selectedText?.trim()).toBe(phrase);
      await expect.element(page.getByRole("button", { name: "Cite", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Cite", exact: true }).click();
      expect(
        useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations[0],
      ).toMatchObject({ source: { messageId }, selection: { text: selectedText } });
    } finally {
      await screen.unmount();
    }
  },
);

it.each([
  { messageId: "cite-user", phrase: "exact" },
  { messageId: "cite-user", phrase: "this exact phrase" },
  { messageId: "cite-assistant", phrase: "quoted" },
  { messageId: "cite-assistant", phrase: "quoted phrase appears here" },
])("centers Cite above '$phrase' in $messageId", async ({ messageId, phrase }) => {
  const screen = await render(<CitationBrowserHarness />);
  try {
    const content = contentFor(messageId);
    content.style.marginLeft = "160px";
    content.style.marginTop = "60px";
    const start = content.textContent!.indexOf(phrase);
    const selection = selectChatText(content, start, start + phrase.length);
    const bounds = selection.getRangeAt(0).getBoundingClientRect();
    await expect.element(page.getByRole("button", { name: "Cite", exact: true })).toBeVisible();
    const toolbar = document.querySelector<HTMLElement>("[data-chat-cite-toolbar]")!;
    const toolbarBounds = toolbar.getBoundingClientRect();
    expect((toolbarBounds.left + toolbarBounds.right) / 2).toBeCloseTo(
      (bounds.left + bounds.right) / 2,
      0,
    );
    expect(toolbarBounds.bottom).toBeLessThan(bounds.top);
    expect(Math.abs(toolbarBounds.top - bounds.top + 40)).toBeLessThan(2);
  } finally {
    await screen.unmount();
  }
});

it.each(["before", "after", "after-frame"])(
  "restores Cite when scrolling %s phrase drag release",
  async (timing) => {
    const screen = await render(<CitationBrowserHarness />);
    const content = contentFor("cite-user");
    content.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, buttons: 1 }),
    );
    const phrase = "keep this exact phrase";
    const start = content.textContent!.indexOf(phrase);
    selectChatText(content, start, start + phrase.length);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const scroller = document.querySelector("[data-chat-cite-scope]")!;
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(document.querySelector("[data-chat-cite-toolbar]")).toBeNull();
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    if (timing === "after-frame") {
      await expect.element(page.getByRole("button", { name: "Cite", exact: true })).toBeVisible();
    }
    if (timing !== "before") scroller.dispatchEvent(new Event("scroll"));
    await expect.element(page.getByRole("button", { name: "Cite", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations[0],
    ).toMatchObject({ source: { messageId: "cite-user" }, selection: { text: phrase } });
    await screen.unmount();
  },
);

it("keeps Cite dismissed after Escape when the chat scrolls", async () => {
  const screen = await render(<CitationBrowserHarness />);
  try {
    const content = contentFor("cite-user");
    selectChatText(content, 0, 11);
    await expect.element(page.getByRole("button", { name: "Cite", exact: true })).toBeVisible();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.querySelector("[data-chat-cite-scope]")!.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(document.querySelector("[data-chat-cite-toolbar]")).toBeNull();
  } finally {
    await screen.unmount();
  }
});
