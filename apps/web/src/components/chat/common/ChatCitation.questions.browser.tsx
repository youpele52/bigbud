import "../../../index.css";
import { ApprovalRequestId } from "@bigbud/contracts/core/baseSchemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { PendingUserInput } from "../../../logic/session/session.logic";
import { useComposerDraftStore } from "../../../stores/composer/composer.store";
import { useSearchStore } from "../../../stores/ui/search.store";
import {
  createFillerMessages,
  createMessage,
} from "../messages/MessagesTimeline.virtualization.test.fixtures";
import { appendAnnotationsToPrompt } from "../view/ChatView.annotations.logic";
import { readChatCitationSelection } from "./ChatCitation.selection";
import { chatPointerCoordinates, nativeDragChatRange } from "./ChatCitation.browser.pointer";
import {
  CITE_THREAD_ID,
  CitationBrowserHarness,
  selectChatText,
} from "./ChatCitation.browser.helpers";

vi.mock("../../../rpc/serverState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../rpc/serverState")>()),
  useServerDiscoveredAgents: () => [],
  useServerDiscoveredSkills: () => [],
}));

const input: PendingUserInput = {
  requestId: ApprovalRequestId.makeUnsafe("theme-request"),
  createdAt: "2026-03-17T19:12:28.000Z",
  questions: [
    {
      id: "theme",
      header: "Theme preference",
      question: "Which theme do you prefer?",
      field: { type: "string", required: false, allowCustom: true },
      options: [
        { label: "Light", description: "Light" },
        { label: "Dark", description: "Dark" },
      ],
    },
  ],
};

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  useSearchStore.setState({ focusRequest: null });
  window.getSelection()?.removeAllRanges();
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  CSS.highlights?.clear();
});

it.each(["Theme preference", "Which theme do you prefer?", "Light"])(
  "cites pending question text: %s",
  async (text) => {
    const screen = await render(
      <CitationBrowserHarness messages={[]} pendingUserInputs={[input]} />,
    );
    const element = page.getByText(text, { exact: true }).element() as HTMLElement;
    selectChatText(element, 0, text.length);
    await expect.element(page.getByRole("button", { name: "Cite", exact: true })).toBeVisible();
    const toolbar = document.querySelector("[data-chat-cite-toolbar]")!.getBoundingClientRect();
    const selectedRect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    expect(toolbar.bottom).toBeLessThanOrEqual(selectedRect.top);
    expect(
      Math.abs(
        (toolbar.left + toolbar.right) / 2 -
          Math.max(52, (selectedRect.left + selectedRect.right) / 2),
      ),
    ).toBeLessThan(2);
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations,
    ).toMatchObject([
      {
        source: { kind: "question", requestId: input.requestId, questionId: "theme" },
        selection: { text },
      },
    ]);
    await expect
      .element(page.getByRole("button", { name: `Go to citation from Question: ${text}` }))
      .toBeVisible();
    await page.getByRole("button", { name: `Go to citation from Question: ${text}` }).click();
    await expect.poll(() => CSS.highlights.get("bigbud-chat-citation")?.size).toBe(1);
    expect(([...CSS.highlights.get("bigbud-chat-citation")!][0] as Range).toString()).toBe(text);
    expect(useSearchStore.getState().focusRequest).toBeNull();
    expect(document.querySelector("textarea")?.value).toBe("");
    await page.getByRole("button", { name: "Remove citation 1" }).click();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations ?? [],
    ).toEqual([]);
    await screen.unmount();
  },
);

it.each([false, true])("cites a native question phrase drag (backward: %s)", async (backward) => {
  const screen = await render(<CitationBrowserHarness messages={[]} pendingUserInputs={[input]} />);
  try {
    const title = page.getByText("Theme preference", { exact: true }).element() as HTMLElement;
    const range = selectChatText(title, 0, title.textContent!.length).getRangeAt(0).cloneRange();
    await nativeDragChatRange(range, backward);
    expect(window.getSelection()!.toString()).toBe("Theme preference");
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Go to citation from Question: Theme preference" }))
      .toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("cites a native triple-clicked question heading", async () => {
  const screen = await render(<CitationBrowserHarness messages={[]} pendingUserInputs={[input]} />);
  try {
    const title = page.getByText("Theme preference", { exact: true }).element() as HTMLElement;
    const bounds = title.getBoundingClientRect();
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
    const selection = window.getSelection()!;
    const selectedText = selection.toString();
    expect(selectedText.trim()).toBe("Theme preference");
    expect(readChatCitationSelection(selection, document.body)).not.toBeNull();
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations[0],
    ).toMatchObject({ selection: { text: selectedText } });
  } finally {
    await screen.unmount();
  }
});

it("keeps an option snapshot anchored across answering and reopens virtualized collapsed history", async () => {
  const screen = await render(<CitationBrowserHarness messages={[]} pendingUserInputs={[input]} />);
  const options = document.querySelector<HTMLElement>('[data-chat-cite-region="prompt"]')!;
  const start = options.textContent!.lastIndexOf("Dark");
  selectChatText(options, start, start + 4);
  await page.getByRole("button", { name: "Cite", exact: true }).click();
  const original =
    useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]!.annotations[0];
  expect(original).toMatchObject({
    source: {
      kind: "question",
      requestId: input.requestId,
      questionId: "theme",
      region: "prompt",
    },
    selection: { text: "Dark", startOffset: start, endOffset: start + 4 },
  });
  const messages = createFillerMessages({
    prefix: "after-question",
    startOffsetSeconds: 10,
    pairCount: 80,
  });
  const answered = { ...input, answers: { theme: "Dark" }, answeredAt: "2026-03-17T19:12:30.000Z" };
  await screen.rerender(
    <CitationBrowserHarness messages={messages} answeredUserInputs={[answered]} />,
  );
  const scroller = document.querySelector<HTMLElement>("[data-chat-cite-scope]")!;
  scroller.scrollTop = scroller.scrollHeight;
  scroller.dispatchEvent(new Event("scroll"));
  await expect
    .poll(() => document.querySelector('[data-chat-cite-request-id="theme-request"]'))
    .toBeNull();
  await page.getByRole("button", { name: "Go to citation from Question: Dark" }).click();
  await expect.poll(() => CSS.highlights.get("bigbud-chat-citation")?.size).toBe(1);
  const range = [...CSS.highlights.get("bigbud-chat-citation")!][0] as Range;
  expect(range.toString()).toBe("Dark");
  const content = document.querySelector<HTMLElement>('[data-chat-cite-region="prompt"]')!;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(content);
  prefix.setEnd(range.startContainer, range.startOffset);
  expect(prefix.toString().length).toBe(start);
  expect(content.closest("details")?.open).toBe(true);
  expect(useSearchStore.getState().focusRequest).toBeNull();
  expect(useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]!.annotations[0]).toEqual(
    original,
  );
  // The source is still citable after answering, not reclassified as the user's answer.
  selectChatText(content, start, start + 4);
  await page.getByRole("button", { name: "Cite", exact: true }).click();
  expect(
    useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]!.annotations[1],
  ).toMatchObject({
    source: original && "source" in original ? original.source : undefined,
    selection: { text: "Dark", startOffset: start },
  });
  await screen.unmount();
});

it("accepts selections across prompt paragraphs but excludes hints, footer, answers and controls", async () => {
  const screen = await render(<CitationBrowserHarness messages={[]} pendingUserInputs={[input]} />);
  const scope = document.querySelector<HTMLElement>("[data-chat-cite-scope]")!;
  for (const element of [
    page.getByText("Optional — leave blank to skip", { exact: false }).element(),
    page.getByText("Input required").element(),
    page.getByText("Type your answer below and press send to continue.").element(),
  ]) {
    expect(
      readChatCitationSelection(selectChatText(element as HTMLElement, 0, 5), scope),
    ).toBeNull();
  }
  const header = page.getByText("Theme preference").element();
  const prompt = page.getByText("Which theme do you prefer?").element();
  const range = document.createRange();
  range.setStart(header.firstChild!, 0);
  range.setEnd(prompt.firstChild!, 5);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  expect(readChatCitationSelection(window.getSelection(), scope)).toMatchObject({
    source: { kind: "question", region: "prompt" },
    selection: { text: window.getSelection()!.toString() },
  });
  await page.getByRole("button", { name: "Cite", exact: true }).click();
  expect(
    useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations,
  ).toHaveLength(1);
  await screen.rerender(
    <CitationBrowserHarness
      messages={[]}
      answeredUserInputs={[
        {
          ...input,
          answers: { theme: "Only my answer" },
          answeredAt: "2026-03-17T19:12:30.000Z",
        },
      ]}
    />,
  );
  await page.getByRole("group").getByText("Question", { exact: true }).click();
  const answer = page.getByText("Only my answer").element() as HTMLElement;
  expect(readChatCitationSelection(selectChatText(answer, 0, 4), scope)).toBeNull();
  const control = page.getByRole("button", { name: "Copy message" }).element();
  expect(control.closest("[data-chat-cite-content]")).toBeNull();
  await screen.unmount();
});

it("rejects selections spanning two questions in the same request", async () => {
  const screen = await render(
    <CitationBrowserHarness
      messages={[]}
      pendingUserInputs={[
        { ...input, questions: [...input.questions, { ...input.questions[0]!, id: "second" }] },
      ]}
    />,
  );
  try {
    const prompts = document.querySelectorAll('[data-chat-cite-region="question"]');
    const range = document.createRange();
    range.setStart(prompts[0]!.firstChild!, 0);
    range.setEnd(prompts[1]!.firstChild!, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(readChatCitationSelection(selection, document.body)).toBeNull();
  } finally {
    await screen.unmount();
  }
});

it("opens the real question source from a sent citation chip after payload parsing", async () => {
  const screen = await render(<CitationBrowserHarness messages={[]} pendingUserInputs={[input]} />);
  selectChatText(page.getByText("Which theme do you prefer?").element() as HTMLElement, 0, 5);
  await page.getByRole("button", { name: "Cite", exact: true }).click();
  const annotations =
    useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]!.annotations;
  const message = createMessage({
    id: "sent-question-citation",
    role: "user",
    offsetSeconds: 10,
    text: appendAnnotationsToPrompt("My own explanation", annotations),
  });
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  await screen.rerender(
    <CitationBrowserHarness
      messages={[message]}
      answeredUserInputs={[
        {
          ...input,
          answers: { theme: "Dark" },
          answeredAt: "2026-03-17T19:12:30.000Z",
        },
      ]}
    />,
  );
  await expect.element(page.getByText("My own explanation")).toBeVisible();
  await page.getByRole("button", { name: "Go to citation from Question: Which" }).click();
  await expect.poll(() => CSS.highlights.get("bigbud-chat-citation")?.size).toBe(1);
  expect(([...CSS.highlights.get("bigbud-chat-citation")!][0] as Range).toString()).toBe("Which");
  expect(document.body.textContent).not.toContain(input.requestId);
  expect(useSearchStore.getState().focusRequest).toBeNull();
  await screen.unmount();
});

it("keeps question offsets stable when answered history hides the generic heading", async () => {
  const genericInput = { ...input, questions: [{ ...input.questions[0]!, header: "Question" }] };
  const screen = await render(
    <CitationBrowserHarness messages={[]} pendingUserInputs={[genericInput]} />,
  );
  try {
    selectChatText(page.getByText("Which theme do you prefer?").element() as HTMLElement, 0, 11);
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    await screen.rerender(
      <CitationBrowserHarness
        messages={[]}
        answeredUserInputs={[
          { ...genericInput, answers: { theme: "Dark" }, answeredAt: "2026-03-17T19:12:30.000Z" },
        ]}
      />,
    );
    await page.getByRole("button", { name: "Go to citation from Question: Which theme" }).click();
    await expect.poll(() => CSS.highlights.get("bigbud-chat-citation")?.size).toBe(1);
    expect(([...CSS.highlights.get("bigbud-chat-citation")!][0] as Range).toString()).toBe(
      "Which theme",
    );
    const header = document.querySelector<HTMLElement>('[data-chat-cite-region="header"]');
    expect(header?.getClientRects().length ?? 0).toBe(0);
  } finally {
    await screen.unmount();
  }
});

it("retains the snapshot without highlighting a changed question passage", async () => {
  const screen = await render(<CitationBrowserHarness messages={[]} pendingUserInputs={[input]} />);
  selectChatText(page.getByText("Which theme do you prefer?").element() as HTMLElement, 0, 5);
  await page.getByRole("button", { name: "Cite", exact: true }).click();
  await screen.rerender(
    <CitationBrowserHarness
      messages={[]}
      pendingUserInputs={[
        {
          ...input,
          questions: [{ ...input.questions[0]!, question: "Other theme prompt" }],
        },
      ]}
    />,
  );
  await page.getByRole("button", { name: "Go to citation from Question: Which" }).click();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(CSS.highlights.get("bigbud-chat-citation")).toBeUndefined();
  expect(
    useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations[0],
  ).toMatchObject({ selection: { text: "Which" } });
  await screen.unmount();
});
