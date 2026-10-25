import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSideChatStore } from "./sideChat.store";

const sideChatThreadId = ThreadId.makeUnsafe("side-chat-thread");

describe("useSideChatStore", () => {
  beforeEach(() => {
    useSideChatStore.setState({
      closedThreadId: null,
      closingThreads: {},
      presentation: "open",
      threadId: null,
    });
  });

  it("keeps a minimized Sidecar available to restore", () => {
    useSideChatStore.getState().show(sideChatThreadId);
    useSideChatStore.getState().minimize();

    expect(useSideChatStore.getState()).toMatchObject({
      presentation: "minimized",
      threadId: sideChatThreadId,
    });

    useSideChatStore.getState().restore();

    expect(useSideChatStore.getState()).toMatchObject({
      presentation: "open",
      threadId: sideChatThreadId,
    });
  });

  it("does not publish another update when showing the open thread again", () => {
    const listener = vi.fn();
    const unsubscribe = useSideChatStore.subscribe(listener);

    useSideChatStore.getState().show(sideChatThreadId);
    expect(listener).toHaveBeenCalledOnce();

    useSideChatStore.getState().show(sideChatThreadId);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
  });

  it("hides a closing Sidecar immediately and frees the slot", () => {
    useSideChatStore.getState().show(sideChatThreadId);
    useSideChatStore.getState().beginClose(sideChatThreadId, "2026-07-12T20:00:00.000Z");

    expect(useSideChatStore.getState()).toMatchObject({
      closedThreadId: null,
      closingThreads: {
        [sideChatThreadId]: { deletionRequested: false, startedAt: "2026-07-12T20:00:00.000Z" },
      },
      presentation: "open",
      threadId: null,
    });

    useSideChatStore.getState().completeClose(sideChatThreadId);

    expect(useSideChatStore.getState()).toMatchObject({
      closedThreadId: sideChatThreadId,
      closingThreads: {},
      presentation: "open",
      threadId: null,
    });
  });

  it("restores the panel when deletion fails and the slot is still free", () => {
    useSideChatStore.getState().show(sideChatThreadId);
    useSideChatStore.getState().beginClose(sideChatThreadId, "2026-07-12T20:00:00.000Z");
    useSideChatStore.getState().failClose(sideChatThreadId);

    expect(useSideChatStore.getState()).toMatchObject({
      closingThreads: {},
      presentation: "open",
      threadId: sideChatThreadId,
    });
  });

  it("keeps a newer Sidecar visible when an older Close fails", () => {
    const newerThreadId = ThreadId.makeUnsafe("newer-side-chat-thread");
    useSideChatStore.getState().show(sideChatThreadId);
    useSideChatStore.getState().beginClose(sideChatThreadId, "2026-07-12T20:00:00.000Z");
    useSideChatStore.getState().beginCreate(newerThreadId);
    useSideChatStore.getState().failClose(sideChatThreadId);

    expect(useSideChatStore.getState()).toMatchObject({
      closingThreads: {},
      presentation: "creating",
      threadId: newerThreadId,
    });
  });

  it("does not show a Sidecar whose Close is still pending", () => {
    useSideChatStore.getState().show(sideChatThreadId);
    useSideChatStore.getState().beginClose(sideChatThreadId, "2026-07-12T20:00:00.000Z");
    useSideChatStore.getState().show(sideChatThreadId);

    expect(useSideChatStore.getState().threadId).toBeNull();
  });

  it("tracks deletion only after the server has requested it", () => {
    useSideChatStore.getState().show(sideChatThreadId);
    useSideChatStore.getState().beginClose(sideChatThreadId, "2026-07-12T20:00:00.000Z");
    useSideChatStore.getState().markDeletionRequested(sideChatThreadId);

    expect(useSideChatStore.getState().closingThreads[sideChatThreadId]).toEqual({
      deletionRequested: true,
      startedAt: "2026-07-12T20:00:00.000Z",
    });
  });

  it("clears a Sidecar that disappeared outside the close flow", () => {
    useSideChatStore.getState().show(sideChatThreadId);
    useSideChatStore.getState().clearMissing(sideChatThreadId);

    expect(useSideChatStore.getState()).toMatchObject({
      closedThreadId: null,
      threadId: null,
    });
  });

  it("does not treat an optimistic creation as a missing thread", () => {
    useSideChatStore.getState().beginCreate(sideChatThreadId);

    expect(useSideChatStore.getState()).toMatchObject({
      presentation: "creating",
      threadId: sideChatThreadId,
    });

    useSideChatStore.getState().completeCreate(sideChatThreadId);

    expect(useSideChatStore.getState()).toMatchObject({
      presentation: "open",
      threadId: sideChatThreadId,
    });
  });

  it("clears a failed creation without marking it closed", () => {
    useSideChatStore.getState().beginCreate(sideChatThreadId);
    useSideChatStore.getState().failCreate(sideChatThreadId);

    expect(useSideChatStore.getState()).toMatchObject({
      closedThreadId: null,
      presentation: "open",
      threadId: null,
    });
  });
});
