import "../../../index.css";
import { ApprovalRequestId, EventId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import type { GetSelectedThreadDetailResult } from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useStore } from "../../../stores/main/main.store";
import { makeThread } from "../../../stores/main/main.store.test.helpers";
import { useComposerDraftStore } from "../../../stores/composer/composer.store";
import { useSearchStore } from "../../../stores/ui/search.store";
import { deriveAnsweredUserInputs } from "../../../logic/session/session.userInputHistory.logic";
import type { PendingUserInput } from "../../../logic/session/session.logic";
import { createMessage } from "../messages/MessagesTimeline.virtualization.test.fixtures";
import {
  CITE_THREAD_ID,
  CitationBrowserHarness,
  selectChatText,
} from "./ChatCitation.browser.helpers";

const mocks = vi.hoisted(() => ({ getDetail: vi.fn() }));
vi.mock("../../../rpc/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../rpc/nativeApi")>()),
  readNativeApi: () => ({ orchestration: { getSelectedThreadDetail: mocks.getDetail } }),
}));
vi.mock("../../../rpc/serverState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../rpc/serverState")>()),
  useServerDiscoveredAgents: () => [],
  useServerDiscoveredSkills: () => [],
}));

const input: PendingUserInput = {
  requestId: ApprovalRequestId.makeUnsafe("older-question-request"),
  createdAt: "2026-03-17T19:12:28.000Z",
  questions: [
    {
      id: "theme",
      header: "Question",
      question: "Which theme do you prefer?",
      field: { type: "string", required: false, allowCustom: true },
      options: [],
    },
  ],
};
const newest = createMessage({
  id: "latest",
  role: "user",
  text: "Latest message",
  offsetSeconds: 100,
});
const firstCursor = { createdAt: newest.createdAt, messageId: newest.id };
const secondCursor = {
  createdAt: "2026-03-17T19:13:00.000Z",
  messageId: MessageId.makeUnsafe("middle"),
};
const history = [
  {
    id: EventId.makeUnsafe("old-request"),
    kind: "user-input.requested",
    tone: "info" as const,
    summary: "Question",
    createdAt: input.createdAt,
    payload: { requestId: input.requestId, questions: input.questions },
    turnId: null,
  },
  {
    id: EventId.makeUnsafe("old-answer"),
    kind: "user-input.resolved",
    tone: "info" as const,
    summary: "Answered",
    createdAt: "2026-03-17T19:12:30.000Z",
    payload: { requestId: input.requestId, answers: { theme: "Dark" } },
    turnId: null,
  },
];

function detail(found: boolean, hasOlder = false): GetSelectedThreadDetailResult {
  const message = createMessage({
    id: found ? "old" : "middle",
    role: "user",
    text: found ? "Earlier turn" : "Middle turn",
    offsetSeconds: found ? 0 : 32,
  });
  return {
    projectionSequence: 1,
    threadId: CITE_THREAD_ID,
    projectId: makeThread({ id: CITE_THREAD_ID }).projectId,
    activityTurnId: null,
    messages: [
      {
        ...message,
        turnId: null,
        updatedAt: message.createdAt,
        attachments: [],
        attachmentsTruncated: false,
      },
    ],
    messageWindow: {
      order: "newest-first",
      requestedCursor: null,
      newestCursor: null,
      oldestCursor: null,
      nextCursor: hasOlder ? secondCursor : null,
      hasOlder,
    },
    activities: found ? history : [],
    activitiesTruncated: false,
    pendingApprovals: [],
    pendingApprovalsTruncated: false,
    pendingUserInputs: [],
    pendingUserInputsTruncated: false,
    activePlan: null,
    activeTasks: [],
    activeTasksTruncated: false,
    checkpoints: [],
    checkpointsTruncated: false,
  };
}

function HistoryHarness() {
  const thread = useStore((state) => state.threads.find((entry) => entry.id === CITE_THREAD_ID));
  return (
    <CitationBrowserHarness
      messages={thread?.messages ?? []}
      answeredUserInputs={deriveAnsweredUserInputs(thread?.activities ?? [])}
    />
  );
}

function highlightedRange() {
  return [...CSS.highlights.get("bigbud-chat-citation")!][0] as Range;
}

beforeEach(() => {
  mocks.getDetail.mockReset();
  useStore.setState({
    threads: [makeThread({ id: CITE_THREAD_ID, messages: [newest] })],
    threadHydrationById: { [CITE_THREAD_ID]: { status: "loaded", nextCursor: firstCursor } },
  });
  useComposerDraftStore.setState({ draftsByThreadId: {} });
  useSearchStore.setState({ focusRequest: null });
  window.getSelection()?.removeAllRanges();
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  CSS.highlights?.clear();
});

it("loads missing question history through real cursor pagination before revealing and highlighting it", async () => {
  const screen = await render(<CitationBrowserHarness messages={[]} pendingUserInputs={[input]} />);
  try {
    selectChatText(page.getByText(input.questions[0]!.question).element() as HTMLElement, 0, 11);
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    const original =
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]!.annotations[0];
    await screen.rerender(<HistoryHarness />);
    expect(document.querySelector(`[data-chat-cite-request-id="${input.requestId}"]`)).toBeNull();
    mocks.getDetail
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(detail(false, true)), 2_100)),
      )
      .mockResolvedValueOnce(detail(true));
    await page.getByRole("button", { name: "Go to citation from Question: Which theme" }).click();
    await expect.poll(() => mocks.getDetail.mock.calls.length, { timeout: 10_000 }).toBe(2);
    expect(mocks.getDetail.mock.calls).toEqual([
      [{ threadId: CITE_THREAD_ID, messageCursor: firstCursor }],
      [{ threadId: CITE_THREAD_ID, messageCursor: secondCursor }],
    ]);
    await expect.poll(() => CSS.highlights.get("bigbud-chat-citation")?.size).toBe(1);
    expect(highlightedRange().toString()).toBe("Which theme");
    expect(highlightedRange().getBoundingClientRect().height).toBeGreaterThan(0);
    expect(
      document
        .querySelector(`[data-chat-cite-request-id="${input.requestId}"] details`)
        ?.hasAttribute("open"),
    ).toBe(true);
    expect(useStore.getState().threadHydrationById[CITE_THREAD_ID]?.status).toBe("complete");
    expect(useSearchStore.getState().focusRequest).toBeNull();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]!.annotations[0],
    ).toEqual(original);
  } finally {
    await screen.unmount();
  }
});

it("retains an unavailable question snapshot without issuing a message-anchor query", async () => {
  const screen = await render(<CitationBrowserHarness messages={[]} pendingUserInputs={[input]} />);
  try {
    selectChatText(page.getByText(input.questions[0]!.question).element() as HTMLElement, 0, 5);
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    await screen.rerender(<HistoryHarness />);
    mocks.getDetail.mockResolvedValueOnce(detail(false));
    await page.getByRole("button", { name: "Go to citation from Question: Which" }).click();
    await expect
      .poll(() => useStore.getState().threadHydrationById[CITE_THREAD_ID]?.status)
      .toBe("complete");
    expect(mocks.getDetail).toHaveBeenCalledExactlyOnceWith({
      threadId: CITE_THREAD_ID,
      messageCursor: firstCursor,
    });
    expect(CSS.highlights.get("bigbud-chat-citation")).toBeUndefined();
    expect(useSearchStore.getState().focusRequest).toBeNull();
    expect(
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations[0],
    ).toMatchObject({ selection: { text: "Which" } });
  } finally {
    await screen.unmount();
  }
});

it.each(["failed", "page-budget"] as const)(
  "stops question history loading on %s and keeps the saved citation",
  async (outcome) => {
    const screen = await render(
      <CitationBrowserHarness messages={[]} pendingUserInputs={[input]} />,
    );
    try {
      selectChatText(page.getByText(input.questions[0]!.question).element() as HTMLElement, 0, 5);
      await page.getByRole("button", { name: "Cite", exact: true }).click();
      await screen.rerender(<HistoryHarness />);
      if (outcome === "failed") mocks.getDetail.mockRejectedValue(new Error("Disconnected"));
      else mocks.getDetail.mockResolvedValue(detail(false, true));
      await page.getByRole("button", { name: "Go to citation from Question: Which" }).click();
      if (outcome === "failed") {
        await expect
          .poll(() => useStore.getState().threadHydrationById[CITE_THREAD_ID]?.status)
          .toBe("failed");
      } else {
        await expect.poll(() => mocks.getDetail.mock.calls.length).toBe(20);
        await expect
          .poll(() => useStore.getState().threadHydrationById[CITE_THREAD_ID]?.status)
          .toBe("loaded");
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      expect(mocks.getDetail).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 20);
      expect(CSS.highlights.get("bigbud-chat-citation")).toBeUndefined();
      expect(
        useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]?.annotations[0],
      ).toMatchObject({ selection: { text: "Which" } });
    } finally {
      await screen.unmount();
    }
  },
);

it("reveals and visibly highlights only the cited generic heading after the question is answered", async () => {
  const questions = [
    input.questions[0]!,
    { ...input.questions[0]!, id: "second", question: "Another prompt?" },
  ];
  const prompt = { ...input, questions };
  const screen = await render(
    <CitationBrowserHarness messages={[]} pendingUserInputs={[prompt]} />,
  );
  try {
    const headings = document.querySelectorAll<HTMLElement>('[data-chat-cite-region="header"]');
    selectChatText(headings[1]!, 3, 11);
    await page.getByRole("button", { name: "Cite", exact: true }).click();
    const saved = useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]!.annotations[0];
    expect(saved).toMatchObject({
      source: { questionId: "second" },
      selection: { text: "Question" },
    });
    await screen.rerender(
      <CitationBrowserHarness
        messages={[]}
        answeredUserInputs={[
          {
            ...prompt,
            answers: { theme: "Dark", second: "Light" },
            answeredAt: "2026-03-17T19:12:30.000Z",
          },
        ]}
      />,
    );
    await page.getByRole("group").getByText("Question", { exact: true }).click();
    const hidden = document.querySelectorAll<HTMLElement>('[data-chat-cite-region="header"]');
    expect([...hidden].every((element) => element.hidden)).toBe(true);
    await page.getByRole("button", { name: "Go to citation from Question: Question" }).click();
    await expect.poll(() => CSS.highlights.get("bigbud-chat-citation")?.size).toBe(1);
    const range = highlightedRange();
    expect(range.toString()).toBe("Question");
    expect(range.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(
      (range.startContainer.parentElement?.closest("[data-chat-cite-question-id]") as HTMLElement)
        ?.dataset.chatCiteQuestionId,
    ).toBe("second");
    expect(hidden[0]!.hidden).toBe(true);
    expect(hidden[1]!.hidden).toBe(false);
    await expect.poll(() => hidden[1]!.hidden, { timeout: 5_000 }).toBe(true);
    expect(
      useComposerDraftStore.getState().draftsByThreadId[CITE_THREAD_ID]!.annotations[0],
    ).toEqual(saved);
  } finally {
    await screen.unmount();
  }
});
