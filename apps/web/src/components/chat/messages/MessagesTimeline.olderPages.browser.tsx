import "../../../index.css";

import {
  MessageId,
  ProjectId,
  ThreadId,
  type GetSelectedThreadDetailInput,
  type GetSelectedThreadDetailResult,
} from "@bigbud/contracts";
import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { deriveTimelineEntries } from "../../../logic/session";
import { useStore } from "../../../stores/main/main.store";
import { makeThread } from "../../../stores/main/main.store.test.helpers";
import { MessagesTimeline } from "./MessagesTimeline";
import { createBaseTimelineProps, isoAt } from "./MessagesTimeline.virtualization.test.fixtures";
import { setViewport, waitForLayout } from "./MessagesTimeline.virtualization.test.helpers";

const getSelectedThreadDetail = vi.hoisted(() => vi.fn());
vi.mock("../../../rpc/nativeApi", () => {
  const readNativeApi = () => ({ orchestration: { getSelectedThreadDetail } });
  return { readNativeApi, ensureNativeApi: readNativeApi };
});

const threadId = ThreadId.makeUnsafe("older-pages-thread");
const TOTAL = 45;
const PAGE = 15;

function storedMessage(index: number) {
  return {
    id: MessageId.makeUnsafe(`older-${String(index).padStart(2, "0")}`),
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `Message ${index}. ${"A line of conversation that wraps a little. ".repeat(3)}`,
    attachments: [],
    attachmentsTruncated: false,
    turnId: null,
    streaming: false,
    createdAt: isoAt(index * 10),
    updatedAt: isoAt(index * 10),
  };
}

/** Server stand-in: the newest `messageLimit` messages older than the cursor, newest first. */
function detailPage(input: GetSelectedThreadDetailInput): GetSelectedThreadDetailResult {
  const before = input.messageCursor
    ? Number(input.messageCursor.messageId.slice("older-".length))
    : TOTAL;
  const start = Math.max(0, before - (input.messageLimit ?? PAGE));
  const messages = Array.from({ length: before - start }, (_, offset) =>
    storedMessage(start + offset),
  );
  const oldest = messages[0];
  return {
    projectionSequence: 1,
    threadId,
    projectId: ProjectId.makeUnsafe("older-pages-project"),
    activityTurnId: null,
    messages: messages.toReversed(),
    messageWindow: {
      order: "newest-first",
      requestedCursor: input.messageCursor ?? null,
      newestCursor: null,
      oldestCursor: null,
      nextCursor:
        start > 0 && oldest ? { createdAt: oldest.createdAt, messageId: oldest.id } : null,
      hasOlder: start > 0,
    },
    activities: [],
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

function StoreBackedTimeline() {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const messages = useStore(
    (state) => state.threads.find((entry) => entry.id === threadId)!.messages,
  );
  const props = useMemo(() => {
    const base = createBaseTimelineProps({});
    return { ...base, timelineEntries: deriveTimelineEntries(messages, [], [], [], []) };
  }, [messages]);
  return (
    <div
      ref={setScrollContainer}
      data-testid="older-pages-scroll"
      style={{ height: 700, overflowY: "auto" }}
    >
      <MessagesTimeline {...props} scrollContainer={scrollContainer} serverThreadId={threadId} />
    </div>
  );
}

const scroller = () =>
  document.querySelector<HTMLDivElement>('[data-testid="older-pages-scroll"]')!;
const rowTop = (id: string) =>
  document.querySelector(`[data-timeline-row-id="${id}"]`)!.getBoundingClientRect().top -
  scroller().getBoundingClientRect().top;

beforeEach(async () => {
  await setViewport({ width: 960, height: 900 });
  getSelectedThreadDetail.mockReset().mockImplementation(async (input) => detailPage(input));
  const first = detailPage({ threadId, messageLimit: PAGE });
  useStore.setState({ threads: [makeThread({ id: threadId })], threadHydrationById: {} });
  useStore.getState().syncSelectedThreadDetail(first, false);
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("MessagesTimeline older pages", () => {
  it("loads 15 older messages at the top without moving the visible rows", async () => {
    let release: (() => void) | undefined;
    getSelectedThreadDetail.mockImplementation(
      (input: GetSelectedThreadDetailInput) =>
        new Promise((resolve) => {
          release = () => resolve(detailPage(input));
        }),
    );
    await render(<StoreBackedTimeline />);
    await vi.waitFor(() => expect(scroller().scrollHeight).toBeGreaterThan(1_400));
    // Opening scrolls to the bottom and asks for nothing more.
    scroller().scrollTop = scroller().scrollHeight;
    scroller().dispatchEvent(new Event("scroll"));
    await waitForLayout();
    expect(getSelectedThreadDetail).not.toHaveBeenCalled();

    // The reader scrolls up to the top.
    scroller().scrollTop = 120;
    scroller().dispatchEvent(new Event("scroll"));
    await waitForLayout();
    const anchorId = "older-31";
    await vi.waitFor(() => expect(getSelectedThreadDetail).toHaveBeenCalledTimes(1));
    await expect
      .poll(() => document.querySelector('[data-older-messages-status="loading"]'))
      .not.toBeNull();
    const before = rowTop(anchorId);
    release?.();

    await vi.waitFor(() => expect(useStore.getState().threads[0]!.messages.length).toBe(2 * PAGE));
    expect(getSelectedThreadDetail).toHaveBeenCalledTimes(1);
    expect(getSelectedThreadDetail.mock.calls[0]![0]).toMatchObject({
      threadId,
      messageLimit: PAGE,
      messageCursor: { messageId: "older-30" },
    });
    await waitForLayout();
    await vi.waitFor(() => expect(Math.abs(rowTop(anchorId) - before)).toBeLessThanOrEqual(4));
    expect(scroller().scrollTop).toBeGreaterThan(OLDER_ROWS_MIN_HEIGHT);
  });

  it("stops at the first message of the thread", async () => {
    await render(<StoreBackedTimeline />);
    for (let page = 0; page < 4; page += 1) {
      await vi.waitFor(() => expect(scroller().scrollHeight).toBeGreaterThan(1_000));
      scroller().scrollTop = scroller().scrollHeight;
      scroller().dispatchEvent(new Event("scroll"));
      await waitForLayout();
      scroller().scrollTop = 0;
      scroller().dispatchEvent(new Event("scroll"));
      await waitForLayout();
      await vi.waitFor(() =>
        expect(useStore.getState().threadHydrationById[threadId]?.status).not.toBe("loadingOlder"),
      );
    }
    expect(useStore.getState().threads[0]!.messages).toHaveLength(TOTAL);
    expect(useStore.getState().threadHydrationById[threadId]).toEqual({ status: "complete" });
    expect(getSelectedThreadDetail).toHaveBeenCalledTimes(TOTAL / PAGE - 1);
  });
});

/** Fifteen prepended messages are far taller than this, so a kept anchor moves scrollTop down. */
const OLDER_ROWS_MIN_HEIGHT = 600;
