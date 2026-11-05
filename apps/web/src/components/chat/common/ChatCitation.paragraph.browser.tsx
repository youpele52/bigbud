import "../../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../../stores/composer/composer.store";
import { useSearchStore } from "../../../stores/ui/search.store";
import { createMessage } from "../messages/MessagesTimeline.virtualization.test.fixtures";
import { readChatCitationSelection } from "./ChatCitation.selection";
import {
  CitationBrowserHarness,
  CITE_THREAD_ID,
  contentFor,
  selectChatText,
} from "./ChatCitation.browser.helpers";
import { chatPointerCoordinates, nativeDragChatRange } from "./ChatCitation.browser.pointer";

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
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  CSS.highlights?.clear();
});

const sentence = "Muse Code powered by Meta Muse, using muse-spark-1.2 (provider muse).";
const messages = [
  createMessage({
    id: "formatted-sentence",
    role: "assistant",
    text: "That message says:\n\nMuse Code powered by Meta Muse, using `muse-spark-1.2` (provider `muse`).",
    offsetSeconds: 0,
  }),
];

it("cites a native triple-clicked formatted sentence", async () => {
  await page.viewport(1280, 720);
  const screen = await render(<CitationBrowserHarness messages={messages} />);
  try {
    const content = contentFor("formatted-sentence");
    const paragraph = content.querySelectorAll("p")[1]!;
    const rect = paragraph.getBoundingClientRect();
    const { x, y } = chatPointerCoordinates(rect.left + 20, rect.top + 10);
    const input = cdp();
    await input.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await input.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 3,
    });
    await input.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 3,
    });
    const selection = window.getSelection()!;
    const selectedText = selection.toString();
    expect(selection.toString().trim()).toContain("Muse Code powered by Meta Muse, using");
    expect(readChatCitationSelection(selection, document.body)).not.toBeNull();
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations[0],
    ).toMatchObject({
      source: { messageId: "formatted-sentence" },
      selection: { text: selectedText },
    });
  } finally {
    await screen.unmount();
  }
});

it.each([false, true])("cites a native full-sentence drag (backward: %s)", async (backward) => {
  await page.viewport(1280, 720);
  const screen = await render(<CitationBrowserHarness messages={messages} />);
  try {
    const content = contentFor("formatted-sentence");
    const paragraph = content.querySelectorAll("p")[1]!;
    const range = selectChatText(paragraph, 0, paragraph.textContent!.length)
      .getRangeAt(0)
      .cloneRange();
    await nativeDragChatRange(range, backward);
    const selection = window.getSelection()!;
    const selectedText = selection.toString();
    expect(selectedText.replace(/\s+/g, " ")).toBe(sentence);
    expect(readChatCitationSelection(selection, document.body)).not.toBeNull();
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations[0],
    ).toMatchObject({
      source: { messageId: "formatted-sentence" },
      selection: { text: selectedText },
    });
  } finally {
    await screen.unmount();
  }
});

it.each(
  (["user", "assistant"] as const).flatMap((role) =>
    ["start", "end", "both", "contents"].map((boundary) => ({ role, boundary })),
  ),
)("cites $role text with $boundary wrapper boundaries", async ({ role, boundary }) => {
  const screen = await render(
    <CitationBrowserHarness
      messages={[
        createMessage({
          id: "whole-message",
          role,
          text: "Select this whole group of words.",
          offsetSeconds: 0,
        }),
      ]}
    />,
  );
  try {
    const content = contentFor("whole-message");
    const inner = selectChatText(content, 0, content.textContent!.length)
      .getRangeAt(0)
      .cloneRange();
    const range = document.createRange();
    range.selectNode(content);
    if (boundary === "start") range.setEnd(inner.endContainer, inner.endOffset);
    if (boundary === "end") range.setStart(inner.startContainer, inner.startOffset);
    if (boundary === "contents") range.selectNodeContents(content);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    const selectedText = selection.toString();
    expect(selectedText.trim()).toBe("Select this whole group of words.");
    expect(readChatCitationSelection(selection, document.body)).not.toBeNull();
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations[0],
    ).toMatchObject({
      source: { messageId: "whole-message", role },
      selection: { text: selectedText },
    });
    await page
      .getByRole("button", {
        name: `Go to citation from ${role === "assistant" ? "AI" : "You"}: ${selectedText}`,
      })
      .click();
    await expect.poll(() => CSS.highlights.get("bigbud-chat-citation")?.size).toBe(1);
    const [highlighted] = [...CSS.highlights.get("bigbud-chat-citation")!] as Range[];
    expect(highlighted!.toString()).toBe("Select this whole group of words.");
  } finally {
    await screen.unmount();
  }
});

it.each(["metadata", "another message"])(
  "rejects wrapper selections including %s",
  async (outside) => {
    const screen = await render(<CitationBrowserHarness />);
    try {
      const content = contentFor("cite-user");
      const range = document.createRange();
      range.setStartBefore(content);
      if (outside === "metadata") {
        range.setEndAfter(content.closest("[data-message-id]")!);
      } else {
        range.setEndAfter(contentFor("cite-assistant"));
      }
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      expect(readChatCitationSelection(selection, document.body)).toBeNull();
    } finally {
      await screen.unmount();
    }
  },
);
