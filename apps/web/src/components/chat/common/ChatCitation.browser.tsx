import "../../../index.css";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../../stores/composer/composer.store";
import { useSearchStore } from "../../../stores/ui/search.store";
import { readChatCitationSelection, resolveChatCitationRange } from "./ChatCitation.selection";
import {
  CITE_MESSAGES,
  CITE_THREAD_ID,
  CitationBrowserHarness,
  contentFor,
  seedCitation,
  selectChatText,
} from "./ChatCitation.browser.helpers";
import { createMessage } from "../messages/MessagesTimeline.virtualization.test.fixtures";
import { buildChatCitationPrompt } from "../../../lib/terminalContext.citations";
import {
  appendTerminalContextsToPrompt,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
} from "../../../lib/terminalContext";

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

it.each(["cite-user", "cite-assistant"])(
  "cites exact rendered text from %s without a suggested instruction",
  async (messageId) => {
    const screen = await render(<CitationBrowserHarness />);
    const content = contentFor(messageId);
    const text = content.textContent!;
    const start = messageId === "cite-user" ? text.indexOf("exact") : text.indexOf("quoted");
    const end = messageId === "cite-user" ? text.indexOf("twice") : start + "quoted phrase".length;
    const selected = selectChatText(content, start, end).toString();
    await expect.element(page.getByRole("button", { name: "Cite", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    const annotations =
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]!.annotations;
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      kind: "chat",
      comment: "",
      intent: "context",
      source: { messageId },
      selection: { text: selected, startOffset: start, endOffset: end },
    });
    expect(document.querySelector("textarea")?.value).toBe("");
    await expect.element(page.getByRole("button", { name: "Remove citation 1" })).toBeVisible();
    await screen.unmount();
  },
);

it("keeps multiple quotes independent and removes only the chosen quote", async () => {
  const screen = await render(<CitationBrowserHarness />);
  for (const messageId of ["cite-user", "cite-assistant"]) {
    selectChatText(contentFor(messageId), 0, 4);
    await page.getByRole("button", { name: "Cite", exact: true }).click();
  }
  expect(
    useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations,
  ).toHaveLength(2);
  await page.getByRole("button", { name: "Remove citation 1" }).click();
  const remaining = useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations;
  expect(remaining).toHaveLength(1);
  expect(remaining?.[0]).toMatchObject({ source: { messageId: "cite-assistant" } });
  await screen.unmount();
});

it("jumps back and highlights the selected occurrence of a repeated phrase", async () => {
  const screen = await render(<CitationBrowserHarness />);
  const content = contentFor("cite-assistant");
  const start = content.textContent!.lastIndexOf("quoted phrase");
  selectChatText(content, start, start + 13);
  await page.getByRole("button", { name: "Cite", exact: true }).click();
  await page.getByRole("button", { name: "Go to citation from AI: quoted phrase" }).click();
  expect(useSearchStore.getState().focusRequest?.messageId).toBe("cite-assistant");
  await expect.poll(() => CSS.highlights.get("bigbud-chat-citation")?.size).toBe(1);
  const highlight = CSS.highlights.get("bigbud-chat-citation")!;
  const range = [...highlight][0] as Range;
  expect(range.toString()).toBe("quoted phrase");
  const prefix = range.cloneRange();
  prefix.selectNodeContents(content);
  prefix.setEnd(range.startContainer, range.startOffset);
  expect(prefix.toString().length).toBe(start);
  await screen.unmount();
});

it("renders sent citations as source links after parsing the persisted message", async () => {
  seedCitation();
  const citation =
    useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]!.annotations[0]!;
  if (citation.kind !== "chat") throw new Error("Expected chat citation");
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  const sent = createMessage({
    id: "cite-sent",
    role: "user",
    text: `My own explanation\n\n${buildChatCitationPrompt(citation)}`,
    offsetSeconds: 3,
  });
  const screen = await render(<CitationBrowserHarness messages={[...CITE_MESSAGES, sent]} />);
  await expect
    .element(page.getByRole("button", { name: "Go to citation from AI: quoted phrase" }))
    .toBeVisible();
  expect(contentFor("cite-sent").textContent).toBe("My own explanation");
  await page.getByRole("button", { name: "Go to citation from AI: quoted phrase" }).click();
  expect(useSearchStore.getState().focusRequest?.messageId).toBe("cite-assistant");
  await screen.unmount();
});

it("rejects cross-message, metadata, and composer selections", async () => {
  const screen = await render(<CitationBrowserHarness />);
  const scope = document.querySelector<HTMLElement>("[data-chat-body]") ?? document.body;
  const selection = selectChatText(contentFor("cite-user"), 0, 4);
  const range = selection.getRangeAt(0);
  range.setEnd(contentFor("cite-assistant").firstChild!, 1);
  expect(readChatCitationSelection(selection, scope)).toBeNull();
  const metadata = document.querySelector<HTMLElement>('[data-testid="uncitable-metadata"]')!;
  selectChatText(metadata, 0, 8);
  expect(readChatCitationSelection(window.getSelection(), scope)).toBeNull();
  expect(
    readChatCitationSelection(
      window.getSelection(),
      document.querySelector('[data-testid="citation-composer"]')!,
    ),
  ).toBeNull();
  await expect.poll(() => document.querySelector("[data-chat-cite-toolbar]")).toBeNull();
  await screen.unmount();
});

it("dismisses Cite on escape and a thread switch", async () => {
  const screen = await render(<CitationBrowserHarness />);
  selectChatText(contentFor("cite-user"), 0, 4);
  await expect.element(page.getByRole("button", { name: "Cite", exact: true })).toBeVisible();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await expect.poll(() => document.querySelector("[data-chat-cite-toolbar]")).toBeNull();
  selectChatText(contentFor("cite-user"), 1, 4);
  await expect.element(page.getByRole("button", { name: "Cite", exact: true })).toBeVisible();
  await screen.rerender(<CitationBrowserHarness threadId={ThreadId.makeUnsafe("other-thread")} />);
  await expect.poll(() => document.querySelector("[data-chat-cite-toolbar]")).toBeNull();
  await screen.unmount();
});

it("preserves quotes when the source changes without highlighting another occurrence", async () => {
  const screen = await render(<CitationBrowserHarness />);
  const content = contentFor("cite-assistant");
  expect(
    resolveChatCitationRange(content, { text: "wrong phrase", startOffset: 2, endOffset: 14 }),
  ).toBeNull();
  expect(
    resolveChatCitationRange(content, { text: "quoted phrase", startOffset: 999, endOffset: 1012 }),
  ).toBeNull();
  await screen.unmount();
});

it("reveals an offscreen virtualized source before highlighting its quote", async () => {
  const messages = Array.from({ length: 60 }, (_, index) =>
    createMessage({
      id: `history-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `History ${index}. ${"Some message text. ".repeat(8)}`,
      offsetSeconds: index,
    }),
  );
  const quote = "History 11.";
  seedCitation("history-11", quote, 0);
  const screen = await render(<CitationBrowserHarness messages={messages} />);
  const scroller = document.querySelector<HTMLElement>("[data-chat-cite-scope]")!;
  scroller.scrollTop = scroller.scrollHeight;
  scroller.dispatchEvent(new Event("scroll"));
  await expect.poll(() => document.querySelector('[data-message-id="history-11"]')).toBeNull();
  await page.getByRole("button", { name: `Go to citation from AI: ${quote}` }).click();
  await expect.poll(() => CSS.highlights.get("bigbud-chat-citation")?.size).toBe(1);
  expect(([...CSS.highlights.get("bigbud-chat-citation")!][0] as Range).toString()).toBe(quote);
  await screen.unmount();
});

it("rejects a whitespace-only source edit that changes the quoted words", async () => {
  const screen = await render(<CitationBrowserHarness />);
  const content = contentFor("cite-assistant");
  content.textContent = "foo bar";
  const selection = selectChatText(content, 0, 7);
  const snapshot = readChatCitationSelection(selection, document.body)!;
  expect(snapshot.selection).toMatchObject({ text: "foo bar", anchorText: "foo bar" });
  content.textContent = "fo obar";
  expect(resolveChatCitationRange(content, snapshot.selection)).toBeNull();
  await screen.unmount();
});

it("preserves rendered paragraph breaks while anchoring to the exact DOM text", async () => {
  const message = createMessage({
    id: "paragraphs",
    role: "assistant",
    text: "First **quoted** paragraph.\n\nSecond paragraph.",
    offsetSeconds: 1,
  });
  const screen = await render(<CitationBrowserHarness messages={[message]} />);
  const content = contentFor("paragraphs");
  const selection = selectChatText(content, 0, content.textContent!.length);
  const selectedText = selection.toString();
  const anchorText = selection.getRangeAt(0).toString();
  const snapshot = readChatCitationSelection(selection, document.body)!;
  expect(snapshot.selection.text).toBe(selectedText);
  expect(snapshot.selection.anchorText).toBe(anchorText);
  expect(resolveChatCitationRange(content, snapshot.selection)?.toString()).toBe(anchorText);
  await screen.unmount();
});

it("keeps Cite inside the viewport when the selected passage extends above and below it", async () => {
  const message = createMessage({
    id: "long-passage",
    role: "assistant",
    offsetSeconds: 1,
    text: Array.from(
      { length: 100 },
      (_, index) => `Paragraph ${index}: a long selected passage.`,
    ).join("\n\n"),
  });
  const screen = await render(<CitationBrowserHarness messages={[message]} />);
  const content = contentFor("long-passage");
  const scroller = document.querySelector<HTMLElement>("[data-chat-cite-scope]")!;
  scroller.scrollTop = scroller.scrollHeight / 2;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  const selection = selectChatText(content, 0, content.textContent!.length);
  const bounds = selection.getRangeAt(0).getBoundingClientRect();
  expect(bounds.top).toBeLessThan(0);
  expect(bounds.bottom).toBeGreaterThan(window.innerHeight);
  await expect
    .poll(() => {
      const rect = document.querySelector("[data-chat-cite-toolbar]")?.getBoundingClientRect();
      return rect !== undefined && rect.top >= 8 && rect.bottom <= window.innerHeight - 8;
    })
    .toBe(true);
  await expect.element(page.getByRole("button", { name: "Cite", exact: true })).toBeVisible();
  await screen.unmount();
});

it("excludes terminal attachment labels and crossing ranges while allowing adjacent message text", async () => {
  const text = appendTerminalContextsToPrompt(
    `Before ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} after`,
    [
      {
        terminalId: "build",
        terminalLabel: "Build",
        lineStart: 1,
        lineEnd: 2,
        text: "output one\noutput two",
      },
    ],
  );
  const message = createMessage({ id: "terminal-reference", role: "user", text, offsetSeconds: 1 });
  const screen = await render(<CitationBrowserHarness messages={[message]} />);
  const content = contentFor("terminal-reference");
  const chip = content.querySelector<HTMLElement>("[data-chat-cite-exclude]")!;
  expect(chip).not.toBeNull();
  const chipStart = content.textContent!.indexOf(chip.textContent!);
  let selection = selectChatText(content, chipStart + 1, chipStart + chip.textContent!.length);
  expect(readChatCitationSelection(selection, document.body)).toBeNull();
  selection = selectChatText(content, 0, content.textContent!.length);
  expect(readChatCitationSelection(selection, document.body)).toBeNull();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(document.querySelector("[data-chat-cite-toolbar]")).toBeNull();
  for (const phrase of ["Before", "after"]) {
    const start = content.textContent!.indexOf(phrase);
    selection = selectChatText(content, start, start + phrase.length);
    expect(readChatCitationSelection(selection, document.body)?.selection.text).toBe(phrase);
  }
  await expect.element(page.getByRole("button", { name: "Cite", exact: true })).toBeVisible();
  await screen.unmount();
});
