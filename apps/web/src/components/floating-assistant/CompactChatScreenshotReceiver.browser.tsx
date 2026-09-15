import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { CompactChatScreenshot } from "@bigbud/contracts/server/ipc.desktopScreenshot.ts";
import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { ThreadComposerSurfaceContext } from "~/components/chat/view/ThreadComposerSurface";
import { useComposerDraftStore } from "~/stores/composer/composer.store";
import { readPersistedAttachmentIdsFromStorage } from "~/stores/composer/persistence.store";
import { makeImage } from "~/stores/composer/composer.store.test.utils";
import { composerStorageKey } from "~/stores/composer/storageKey.store";

import { CompactChatScreenshotReceiver } from "./CompactChatScreenshotReceiver";

const THREAD_ID = ThreadId.makeUnsafe("floating-thread");
const image: CompactChatScreenshot = {
  id: "desktop-capture-1",
  threadId: THREAD_ID,
  name: "Screenshot.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 4,
  dataUrl: "data:image/jpeg;base64,anBlZw==",
};
function context(threadId = THREAD_ID, blocked = false) {
  return {
    base: { threadId, isConnecting: false, sendInFlightRef: { current: false } },
    thread: { pendingUserInputs: blocked ? [{}] : [], isPreparingWorktree: false },
  } as unknown as ThreadComposerSurfaceContext;
}
function setupBridge(screenshot = image) {
  let pending: CompactChatScreenshot | null = screenshot;
  const listeners = new Set<() => void>();
  const getPending = vi.fn(async () => pending);
  const acknowledge = vi.fn(async () => {
    pending = null;
    return true;
  });
  window.desktopBridge = {
    compactChatScreenshot: {
      getPending,
      acknowledge,
      onAvailable: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  } as unknown as DesktopBridge;
  return {
    getPending,
    acknowledge,
    listeners,
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
}

describe("floating screenshot receiver", () => {
  beforeEach(() => {
    localStorage.clear();
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "desktopBridge");
  });

  it("pulls a waiting image on mount, preserves the draft, persists it and acknowledges exactly once", async () => {
    const bridge = setupBridge();
    const store = useComposerDraftStore.getState();
    store.setPrompt(THREAD_ID, "Explain this error");
    store.addImage(
      THREAD_ID,
      makeImage({ id: "existing", name: "existing.png", previewUrl: "data:image/png;base64,AA==" }),
    );
    const mounted = await render(<CompactChatScreenshotReceiver context={context()} />);
    try {
      await vi.waitFor(() => expect(bridge.acknowledge).toHaveBeenCalledExactlyOnceWith(image.id));
      const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]!;
      expect(draft.prompt).toBe("Explain this error");
      expect(draft.images.map((entry) => entry.id)).toEqual(["existing", image.id]);
      expect(draft.images[1]?.file.size).toBe(4);
      expect(readPersistedAttachmentIdsFromStorage(THREAD_ID)).toContain(image.id);
      bridge.notify();
      bridge.notify();
      await vi.waitFor(() => expect(bridge.getPending).toHaveBeenCalledTimes(3));
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.images).toHaveLength(2);
    } finally {
      await mounted.unmount();
    }
    expect(bridge.listeners.size).toBe(0);
  });

  it("retries failed acknowledgement without reattaching, even after the user removes the image", async () => {
    const bridge = setupBridge();
    bridge.acknowledge.mockRejectedValueOnce(new Error("IPC interrupted"));
    const mounted = await render(<CompactChatScreenshotReceiver context={context()} />);
    try {
      await expect.element(page.getByText("IPC interrupted")).toBeInTheDocument();
      useComposerDraftStore.getState().removeImage(THREAD_ID, image.id);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await vi.waitFor(() => expect(bridge.acknowledge).toHaveBeenCalledTimes(2));
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.images ?? []).toEqual(
        [],
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("deduplicates replay after renderer reload using the stored image ID", async () => {
    const bridge = setupBridge();
    bridge.acknowledge.mockRejectedValueOnce(new Error("reload"));
    const first = await render(<CompactChatScreenshotReceiver context={context()} />);
    await vi.waitFor(() => expect(bridge.acknowledge).toHaveBeenCalledOnce());
    await first.unmount();
    const persisted = localStorage.getItem(composerStorageKey)!;
    useComposerDraftStore.setState({ draftsByThreadId: {} });
    localStorage.setItem(composerStorageKey, persisted);
    await useComposerDraftStore.persist.rehydrate();
    const second = await render(<CompactChatScreenshotReceiver context={context()} />);
    try {
      await vi.waitFor(() => expect(bridge.acknowledge).toHaveBeenCalledTimes(2));
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.images).toHaveLength(1);
    } finally {
      await second.unmount();
    }
  });

  it("retains a full draft's pending screenshot until an attachment is removed and retried", async () => {
    const bridge = setupBridge();
    useComposerDraftStore.getState().addImages(
      THREAD_ID,
      Array.from({ length: 8 }, (_, index) =>
        makeImage({
          id: String(index),
          name: `image-${index}.png`,
          previewUrl: "data:image/png;base64,AA==",
        }),
      ),
    );
    const mounted = await render(<CompactChatScreenshotReceiver context={context()} />);
    try {
      await expect.element(page.getByText(/Remove an attachment/)).toBeInTheDocument();
      expect(bridge.acknowledge).not.toHaveBeenCalled();
      useComposerDraftStore.getState().removeImage(THREAD_ID, "0");
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await vi.waitFor(() => expect(bridge.acknowledge).toHaveBeenCalledOnce());
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.images).toHaveLength(8);
    } finally {
      await mounted.unmount();
    }
  });

  it("waits while questions are pending and retries when the composer becomes available", async () => {
    const bridge = setupBridge();
    const mounted = await render(
      <CompactChatScreenshotReceiver context={context(THREAD_ID, true)} />,
    );
    try {
      await expect.element(page.getByText(/Screenshot is waiting/)).toBeInTheDocument();
      expect(bridge.acknowledge).not.toHaveBeenCalled();
      await mounted.rerender(<CompactChatScreenshotReceiver context={context()} />);
      await vi.waitFor(() => expect(bridge.acknowledge).toHaveBeenCalledOnce());
    } finally {
      await mounted.unmount();
    }
  });

  it("does not redirect a claimed screenshot when a different conversation is selected", async () => {
    const bridge = setupBridge();
    const other = ThreadId.makeUnsafe("other-thread");
    const mounted = await render(<CompactChatScreenshotReceiver context={context(other)} />);
    try {
      await expect.element(page.getByText(/belongs to another floating chat/)).toBeInTheDocument();
      expect(useComposerDraftStore.getState().draftsByThreadId[other]).toBeUndefined();
      expect(bridge.acknowledge).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Discard screenshot" }).click();
      await vi.waitFor(() => expect(bridge.acknowledge).toHaveBeenCalledExactlyOnceWith(image.id));
    } finally {
      await mounted.unmount();
    }
  });

  it("ignores a late reply after unmount and recovers it on the next mount", async () => {
    const bridge = setupBridge();
    let reply!: (value: CompactChatScreenshot | null) => void;
    bridge.getPending.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const first = await render(<CompactChatScreenshotReceiver context={context()} />);
    await vi.waitFor(() => expect(bridge.getPending).toHaveBeenCalledOnce());
    await first.unmount();
    reply(image);
    await Promise.resolve();
    expect(bridge.acknowledge).not.toHaveBeenCalled();
    const second = await render(<CompactChatScreenshotReceiver context={context()} />);
    try {
      await vi.waitFor(() => expect(bridge.acknowledge).toHaveBeenCalledOnce());
      expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.images).toHaveLength(1);
    } finally {
      await second.unmount();
    }
  });
});
