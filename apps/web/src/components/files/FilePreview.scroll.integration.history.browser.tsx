import { flushSync } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  HISTORY_WORKSPACE,
  HistoryPreview,
  assertScrollable,
  moveReader,
  previewMocks,
  previewViewport,
  resetPreviewMocks,
  switchMode,
} from "./FilePreview.scroll.integration.fixtures";
import { useFilesPanelStore } from "../../stores/files/filesPanel.store";

function historyEntry(index: number) {
  return useFilesPanelStore.getState().histories[HISTORY_WORKSPACE]!.entries[index]!;
}

async function waitForPreviewAt(top: number) {
  await vi.waitFor(() => expect(document.querySelector(".file-preview-markdown")).not.toBeNull());
  const preview = previewViewport();
  assertScrollable(preview);
  await vi.waitFor(() => expect(Math.abs(preview.scrollTop - top)).toBeLessThanOrEqual(2));
  return preview;
}

describe("FilePreview existing numeric history integration", () => {
  beforeEach(() => {
    resetPreviewMocks();
    useFilesPanelStore.setState({
      workspaceKey: HISTORY_WORKSPACE,
      historyKeys: [HISTORY_WORKSPACE],
      previewPath: "docs/CHANGELOG.md",
      histories: {
        [HISTORY_WORKSPACE]: {
          index: 0,
          entries: [
            { path: "docs/CHANGELOG.md", position: null, scrollTop: 610 },
            { path: "docs/OTHER.mdx", position: null, scrollTop: 0 },
          ],
        },
      },
    });
  });

  it("persists final mode positions including zero without adding history entries or refetching", async () => {
    const mounted = await render(<HistoryPreview />);
    try {
      const initial = await waitForPreviewAt(610);
      moveReader(initial, 907);
      await vi.waitFor(() => expect(historyEntry(0).scrollTop).toBe(907));

      const raw = await switchMode("raw");
      await vi.waitFor(() => expect(historyEntry(0).scrollTop).toBe(raw.scrollTop));
      expect(raw.scrollTop).toBeGreaterThan(0);
      const preview = await switchMode("preview");
      await vi.waitFor(() => expect(historyEntry(0).scrollTop).toBe(preview.scrollTop));
      expect(Math.abs(preview.scrollTop - 907)).toBeLessThanOrEqual(2);

      moveReader(preview, 0);
      await vi.waitFor(() => expect(historyEntry(0).scrollTop).toBe(0));
      const history = useFilesPanelStore.getState().histories[HISTORY_WORKSPACE]!;
      expect(history.index).toBe(0);
      expect(history.entries.map(({ path }) => path)).toEqual([
        "docs/CHANGELOG.md",
        "docs/OTHER.mdx",
      ]);
      expect(previewMocks.read).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });

  it("flushes pending scrolls on back/forward, restores zero, and restores numeric history after reopening", async () => {
    const mounted = await render(<HistoryPreview />);
    try {
      moveReader(await waitForPreviewAt(610), 947);
      document.querySelector<HTMLButtonElement>('[aria-label="Forward"]')!.click();
      await vi.waitFor(() =>
        expect(previewMocks.read).toHaveBeenLastCalledWith({
          cwd: "/workspace",
          relativePath: "docs/OTHER.mdx",
        }),
      );
      const next = await waitForPreviewAt(0);
      expect(historyEntry(0).scrollTop).toBe(947);
      moveReader(next, 432);
      document.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click();
      await vi.waitFor(() =>
        expect(previewMocks.read).toHaveBeenLastCalledWith({
          cwd: "/workspace",
          relativePath: "docs/CHANGELOG.md",
        }),
      );
      await waitForPreviewAt(947);
      expect(historyEntry(1).scrollTop).toBe(432);

      const raw = await switchMode("raw");
      moveReader(raw, 573);
      document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
      await vi.waitFor(() => expect(document.querySelector(".file-preview-code")).toBeNull());
      expect(historyEntry(0).scrollTop).toBe(573);
      document.querySelector<HTMLButtonElement>("button")!.click();
      await waitForPreviewAt(573);
      expect(useFilesPanelStore.getState().histories[HISTORY_WORKSPACE]!.entries).toHaveLength(2);
      expect(previewMocks.read).toHaveBeenCalledTimes(4);
    } finally {
      await mounted.unmount();
    }
  });

  it("flushes the restored destination before its history debounce when immediately unmounted", async () => {
    const mounted = await render(<HistoryPreview />);
    let unmounted = false;
    let destinationTop = 0;
    try {
      await waitForPreviewAt(610);
      const raw = await switchMode("raw");
      moveReader(raw, 670);
      await vi.waitFor(() => expect(historyEntry(0).scrollTop).toBe(670));

      // Keep layout and React real while the history debounce remains pending.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      flushSync(() => {
        document.querySelector<HTMLButtonElement>('[aria-label="View markdown preview"]')!.click();
      });
      const destination = previewViewport();
      assertScrollable(destination);
      destinationTop = destination.scrollTop;
      expect(destinationTop).toBeGreaterThan(0);
      expect(Math.abs(destinationTop - 670)).toBeGreaterThan(2);
      expect(historyEntry(0).scrollTop).toBe(670);

      await mounted.unmount();
      unmounted = true;
      expect(historyEntry(0).scrollTop).toBe(destinationTop);
    } finally {
      if (!unmounted) await mounted.unmount();
      vi.useRealTimers();
    }

    const reopened = await render(<HistoryPreview />);
    try {
      await waitForPreviewAt(destinationTop);
      expect(previewMocks.read).toHaveBeenCalledTimes(2);
    } finally {
      await reopened.unmount();
    }
  });
});
