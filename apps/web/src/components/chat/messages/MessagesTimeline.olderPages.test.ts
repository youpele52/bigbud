import {
  MessageId,
  ProjectId,
  ThreadId,
  type GetSelectedThreadDetailResult,
  type NativeApi,
  type ThreadMessageCursor,
} from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadOlderThreadMessages } from "~/routes/-__root.bounded-bootstrap";
import { useStore } from "~/stores/main/main.store";
import { makeThread } from "~/stores/main/main.store.test.helpers";
import {
  captureOlderPageAnchor,
  requestOlderMessagePage,
  resolveAnchoredScrollTop,
  resolveOlderPagesStatus,
  shouldRequestOlderPage,
} from "./MessagesTimeline.olderPages";

const threadId = ThreadId.makeUnsafe("thread-older");
const cursor = (id: string): ThreadMessageCursor => ({
  createdAt: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
  messageId: MessageId.makeUnsafe(`message-${id}`),
});

function message(index: number) {
  return {
    id: MessageId.makeUnsafe(`message-${index}`),
    role: "user" as const,
    text: `message ${index}`,
    attachments: [],
    attachmentsTruncated: false,
    turnId: null,
    streaming: false,
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  };
}

function page(indexes: number[], hasOlder: boolean): GetSelectedThreadDetailResult {
  return {
    projectionSequence: 1,
    threadId,
    projectId: ProjectId.makeUnsafe("project-1"),
    activityTurnId: null,
    messages: indexes.toReversed().map(message),
    messageWindow: {
      order: "newest-first",
      requestedCursor: null,
      newestCursor: null,
      oldestCursor: null,
      nextCursor: hasOlder ? cursor(String(indexes[0])) : null,
      hasOlder,
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

function apiWith(getSelectedThreadDetail: ReturnType<typeof vi.fn>) {
  return { orchestration: { getSelectedThreadDetail } } as unknown as NativeApi;
}

beforeEach(() => {
  useStore.setState({
    threads: [makeThread({ id: threadId })],
    threadHydrationById: { [threadId]: { status: "loaded", nextCursor: cursor("40") } },
  });
});

describe("older message pages", () => {
  it("allows one request in flight per thread", async () => {
    let release: (() => void) | undefined;
    const load = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const first = requestOlderMessagePage(threadId, load);
    const second = await requestOlderMessagePage(threadId, load);
    release?.();

    expect(second).toBe(false);
    expect(await first).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await requestOlderMessagePage(threadId, async () => {})).toBe(true);
  });

  it("asks for a page only near the top, after the reader scrolled up", () => {
    const base = { status: "idle" as const, scrollHeight: 4000, clientHeight: 800 };
    expect(shouldRequestOlderPage({ ...base, scrollTop: 0, userScrolledUp: false })).toBe(false);
    expect(shouldRequestOlderPage({ ...base, scrollTop: 100, userScrolledUp: true })).toBe(true);
    expect(shouldRequestOlderPage({ ...base, scrollTop: 900, userScrolledUp: true })).toBe(false);
    // A timeline too short to scroll fills itself.
    expect(
      shouldRequestOlderPage({ ...base, scrollHeight: 600, scrollTop: 0, userScrolledUp: false }),
    ).toBe(true);
    for (const status of ["loading", "error", "complete", "unavailable"] as const) {
      expect(shouldRequestOlderPage({ ...base, status, scrollTop: 0, userScrolledUp: true })).toBe(
        false,
      );
    }
  });

  it("stops at the start of the thread", () => {
    expect(resolveOlderPagesStatus({ status: "complete" })).toBe("complete");
    expect(resolveOlderPagesStatus({ status: "loaded", nextCursor: null })).toBe("complete");
    expect(resolveOlderPagesStatus({ status: "loaded", nextCursor: cursor("1") })).toBe("idle");
    expect(resolveOlderPagesStatus({ status: "loadingOlder" })).toBe("loading");
    expect(resolveOlderPagesStatus(undefined)).toBe("unavailable");
  });

  it("requests 15 older messages, dedupes an overlapping page and stops at the start", async () => {
    useStore.setState({
      threads: [
        makeThread({
          id: threadId,
          messages: [40, 41].map(message),
        }),
      ],
    });
    const getSelectedThreadDetail = vi.fn().mockResolvedValue(page([39, 40], false));

    await loadOlderThreadMessages({ api: apiWith(getSelectedThreadDetail), threadId });

    expect(getSelectedThreadDetail).toHaveBeenCalledWith({
      threadId,
      messageCursor: cursor("40"),
      messageLimit: 15,
    });
    const thread = useStore.getState().threads[0]!;
    expect(thread.messages.map((entry) => entry.id)).toEqual([
      "message-39",
      "message-40",
      "message-41",
    ]);
    expect(resolveOlderPagesStatus(useStore.getState().threadHydrationById[threadId])).toBe(
      "complete",
    );
  });

  it("surfaces an error and retries from the same cursor", async () => {
    const getSelectedThreadDetail = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(page([38, 39], true));
    const api = apiWith(getSelectedThreadDetail);

    await loadOlderThreadMessages({ api, threadId });
    expect(resolveOlderPagesStatus(useStore.getState().threadHydrationById[threadId])).toBe(
      "error",
    );

    await loadOlderThreadMessages({ api, threadId });
    expect(getSelectedThreadDetail).toHaveBeenNthCalledWith(2, {
      threadId,
      messageCursor: cursor("40"),
      messageLimit: 15,
    });
    expect(resolveOlderPagesStatus(useStore.getState().threadHydrationById[threadId])).toBe("idle");
  });

  it("keeps the first visible row at the same offset after a page is prepended", () => {
    const before = [
      { id: "row-a", start: 0, end: 300 },
      { id: "row-b", start: 300, end: 700 },
      { id: "row-c", start: 700, end: 1000 },
    ];
    const anchor = captureOlderPageAnchor(before, 350, 1000);
    expect(anchor).toMatchObject({ rowId: "row-b", rowIndex: 1, offset: -50 });

    const prepended = [
      { id: "older-1", start: 0, end: 500 },
      { id: "older-2", start: 500, end: 900 },
      ...before.map((row) => ({ id: row.id, start: row.start + 900, end: row.end + 900 })),
    ];
    expect(resolveAnchoredScrollTop(anchor, prepended, 1900)).toBe(1250);
    // Without a measured anchor row, the distance from the bottom is kept instead.
    expect(resolveAnchoredScrollTop({ ...anchor, rowId: "missing" }, prepended, 1900)).toBe(1250);
  });
});
