import {
  EventId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ThreadId,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchCommandMock = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("~/rpc/nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { dispatchCommand: dispatchCommandMock } }),
}));

import { createEmptyThreadDraft, useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";
import { makeState, makeThread } from "~/stores/main/main.store.test.helpers";
import { useSideChatStore } from "~/stores/sideChat";

import {
  applySideChatLifecycleEvents,
  attachSidecarToComposer,
  closeSideChat,
  completeSideChatClose,
  openSideChat,
  reconcileSideChatSnapshot,
} from "./sideChat.actions";

const mainThreadId = ThreadId.makeUnsafe("main-thread");
const sidecarThreadId = ThreadId.makeUnsafe("sidecar-thread");

function sidecarMessage() {
  return {
    id: MessageId.makeUnsafe("sidecar-message"),
    role: "assistant" as const,
    text: "Useful context",
    turnId: null,
    createdAt: "2026-07-12T20:00:00.000Z",
    completedAt: "2026-07-12T20:00:01.000Z",
    streaming: false,
  };
}

function lifecycleEvent(
  type: OrchestrationEvent["type"],
  payload: Record<string, unknown>,
): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe(`event-${type}`),
    aggregateKind: "thread",
    aggregateId: sidecarThreadId,
    occurredAt: "2026-07-12T20:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
  } as OrchestrationEvent;
}

function setThreads(options?: { emptySidecar?: boolean }) {
  const mainThread = makeThread({ id: mainThreadId, purpose: "standard" });
  const sidecarThread = makeThread({
    id: sidecarThreadId,
    purpose: "side-chat",
    title: "Sidecar",
    messages: options?.emptySidecar ? [] : [sidecarMessage()],
  });
  useStore.setState({ ...makeState(mainThread), threads: [mainThread, sidecarThread] });
}

describe("attachSidecarToComposer", () => {
  beforeEach(() => {
    dispatchCommandMock.mockReset();
    dispatchCommandMock.mockResolvedValue(undefined);
    setThreads();
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useSideChatStore.setState({
      closedThreadId: null,
      closeStartedAt: null,
      deletionRequested: false,
      presentation: "open",
      threadId: null,
    });
  });

  it("adds a non-watching thread reference to the main composer", () => {
    expect(attachSidecarToComposer({ mainThreadId, sidecarThreadId })).toBe(true);

    expect(useComposerDraftStore.getState().draftsByThreadId[mainThreadId]?.files).toEqual([
      expect.objectContaining({
        attachmentMode: "thread-reference",
        mimeType: "application/x-bigbud-thread-reference",
        name: "Sidecar",
        threadId: sidecarThreadId,
        threadTitle: "Sidecar",
        watchForCompletion: false,
      }),
    ]);
  });

  it("does not attach an empty Sidecar", () => {
    setThreads({ emptySidecar: true });

    expect(attachSidecarToComposer({ mainThreadId, sidecarThreadId })).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadId[mainThreadId]).toBeUndefined();
  });

  it("deduplicates repeated Sidecar references", () => {
    expect(attachSidecarToComposer({ mainThreadId, sidecarThreadId })).toBe(true);
    expect(attachSidecarToComposer({ mainThreadId, sidecarThreadId })).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadId[mainThreadId]?.files).toHaveLength(1);
  });

  it("does not attach to the Sidecar itself", () => {
    expect(
      attachSidecarToComposer({
        mainThreadId: sidecarThreadId,
        sidecarThreadId,
      }),
    ).toBe(false);
  });

  it("rejects missing or deleting threads", () => {
    useStore.setState((state) => ({
      threads: state.threads.filter((thread) => thread.id !== mainThreadId),
    }));
    expect(attachSidecarToComposer({ mainThreadId, sidecarThreadId })).toBe(false);

    setThreads();
    useStore.setState((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === sidecarThreadId
          ? { ...thread, deletingAt: "2026-07-12T20:01:00.000Z" }
          : thread,
      ),
    }));
    expect(attachSidecarToComposer({ mainThreadId, sidecarThreadId })).toBe(false);
  });

  it("respects the composer attachment limit", () => {
    const files = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
      type: "file" as const,
      id: `file-${index}`,
      name: `file-${index}.txt`,
      mimeType: "text/plain",
      sizeBytes: 0,
      attachmentMode: "path-reference" as const,
      entryKind: "file" as const,
      filePath: `/tmp/file-${index}.txt`,
      file: null,
    }));
    useComposerDraftStore.setState({
      draftsByThreadId: {
        [mainThreadId]: { ...createEmptyThreadDraft(), files },
      },
    });

    expect(attachSidecarToComposer({ mainThreadId, sidecarThreadId })).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadId[mainThreadId]?.files).toEqual(files);
  });

  it("removes Sidecar context from unsent drafts once deletion completes", () => {
    expect(attachSidecarToComposer({ mainThreadId, sidecarThreadId })).toBe(true);
    useSideChatStore.getState().show(sidecarThreadId);

    completeSideChatClose(sidecarThreadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[mainThreadId]).toBeUndefined();
    expect(useSideChatStore.getState()).toMatchObject({
      closedThreadId: sidecarThreadId,
      threadId: null,
    });
  });

  it("detaches context immediately and restores it from a batched deletion failure", async () => {
    let resolveDelete: (() => void) | undefined;
    dispatchCommandMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    expect(attachSidecarToComposer({ mainThreadId, sidecarThreadId })).toBe(true);
    useSideChatStore.getState().show(sidecarThreadId);

    const closePromise = closeSideChat(sidecarThreadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[mainThreadId]).toBeUndefined();
    expect(useSideChatStore.getState().presentation).toBe("closing");
    resolveDelete?.();
    await closePromise;

    applySideChatLifecycleEvents([
      lifecycleEvent("thread.deletion-requested", {
        threadId: sidecarThreadId,
        deletingAt: "2026-07-12T20:00:01.000Z",
      }),
      lifecycleEvent("thread.deletion-failed", {
        threadId: sidecarThreadId,
        updatedAt: "2026-07-12T20:00:02.000Z",
      }),
    ]);

    expect(useComposerDraftStore.getState().draftsByThreadId[mainThreadId]?.files).toHaveLength(1);
    expect(useSideChatStore.getState().presentation).toBe("open");
  });

  it("does not create a duplicate while the first Sidecar is still creating", async () => {
    let resolveCreate: (() => void) | undefined;
    dispatchCommandMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    useStore.setState((state) => ({
      threads: state.threads.filter((thread) => thread.id === mainThreadId),
    }));
    const mainThread = useStore.getState().threads.find((thread) => thread.id === mainThreadId)!;

    const firstOpen = openSideChat(mainThread);
    await openSideChat(mainThread);

    expect(dispatchCommandMock).toHaveBeenCalledOnce();
    expect(useSideChatStore.getState().presentation).toBe("creating");
    resolveCreate?.();
    await firstOpen;
  });

  it("restores a failed Close from an authoritative snapshot", async () => {
    expect(attachSidecarToComposer({ mainThreadId, sidecarThreadId })).toBe(true);
    useSideChatStore.getState().show(sidecarThreadId);

    await closeSideChat(sidecarThreadId);
    const closeStartedAt = useSideChatStore.getState().closeStartedAt!;
    const sidecar = useStore.getState().threads.find((thread) => thread.id === sidecarThreadId)!;
    const failedSidecar = {
      ...sidecar,
      activities: [
        ...sidecar.activities,
        {
          id: EventId.makeUnsafe("sidecar-delete-failed"),
          kind: "thread.delete.failed",
          summary: "Thread deletion failed",
          tone: "error" as const,
          payload: {},
          turnId: null,
          createdAt: closeStartedAt,
        },
      ],
    };

    reconcileSideChatSnapshot([failedSidecar]);

    expect(useSideChatStore.getState().presentation).toBe("open");
    expect(useComposerDraftStore.getState().draftsByThreadId[mainThreadId]?.files).toHaveLength(1);
  });
});
