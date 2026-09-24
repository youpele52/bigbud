import "../../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_VIEWPORT,
  createBaseTimelineProps,
  createChangedFilesSummary,
  createFillerMessages,
  createMessage,
  measureTimelineRow,
  mountMessagesTimeline,
  setViewport,
} from "./MessagesTimeline.virtualization.test.helpers";

describe("MessagesTimeline changed-files row sizing", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await setViewport(DEFAULT_VIEWPORT);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the changed-files row virtualizer size in sync after collapsing directories", async () => {
    const beforeMessages = createFillerMessages({
      prefix: "before-collapse",
      startOffsetSeconds: 0,
      pairCount: 2,
    });
    const afterMessages = createFillerMessages({
      prefix: "after-collapse",
      startOffsetSeconds: 40,
      pairCount: 8,
    });
    const targetMessage = createMessage({
      id: "target-assistant-collapse",
      role: "assistant",
      text: "Validation passed on the merged tree.",
      offsetSeconds: 12,
    });
    const props = createBaseTimelineProps({
      messages: [...beforeMessages, targetMessage, ...afterMessages],
      turnDiffSummaryByAssistantMessageId: createChangedFilesSummary(targetMessage.id, [
        { path: "docs/plans/_test-data--do-not-delete.md", additions: 89, deletions: 0 },
        {
          path: "apps/server/src/checkpointing/Layers/CheckpointDiffQuery.ts",
          additions: 4,
          deletions: 3,
        },
        {
          path: "apps/server/src/checkpointing/Layers/CheckpointStore.ts",
          additions: 131,
          deletions: 128,
        },
        {
          path: "apps/server/src/checkpointing/Layers/CheckpointStore.test.ts",
          additions: 1,
          deletions: 1,
        },
        { path: "apps/server/src/checkpointing/Errors.ts", additions: 1, deletions: 1 },
        {
          path: "apps/server/src/git/Layers/ClaudeTextGeneration.ts",
          additions: 106,
          deletions: 112,
        },
        { path: "apps/server/src/git/Layers/GitCore.ts", additions: 44, deletions: 38 },
        { path: "apps/server/src/git/Layers/GitCore.test.ts", additions: 18, deletions: 9 },
        {
          path: "apps/web/src/components/chat/MessagesTimeline.tsx",
          additions: 52,
          deletions: 7,
        },
        {
          path: "apps/web/src/components/chat/ChangedFilesTree.tsx",
          additions: 32,
          deletions: 4,
        },
        { path: "packages/contracts/src/orchestration.ts", additions: 13, deletions: 3 },
        { path: "packages/shared/src/git.ts", additions: 8, deletions: 2 },
      ]),
    });
    const mounted = await mountMessagesTimeline({
      props,
      viewport: { width: 320, height: 700 },
    });

    try {
      const targetRowElement = mounted.host.querySelector<HTMLElement>(
        `[data-timeline-row-id="${targetMessage.id}"]`,
      );
      expect(targetRowElement, "Unable to locate target changed-files row.").toBeTruthy();

      const expandAllButton =
        Array.from(targetRowElement!.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => button.textContent?.trim() === "Expand all",
        ) ?? null;
      expect(expandAllButton, 'Unable to find "Expand all" button.').toBeTruthy();
      expandAllButton!.click();

      const beforeCollapse = await measureTimelineRow({
        host: mounted.host,
        props,
        targetRowId: targetMessage.id,
      });
      const collapseAllButton =
        Array.from(targetRowElement!.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => button.textContent?.trim() === "Collapse all",
        ) ?? null;
      expect(collapseAllButton, 'Unable to find "Collapse all" button.').toBeTruthy();

      collapseAllButton!.click();

      await vi.waitFor(
        async () => {
          const afterCollapse = await measureTimelineRow({
            host: mounted.host,
            props,
            targetRowId: targetMessage.id,
          });
          expect(afterCollapse.actualHeightPx).toBeLessThan(beforeCollapse.actualHeightPx - 24);
        },
        { timeout: 8_000, interval: 16 },
      );

      const afterCollapse = await measureTimelineRow({
        host: mounted.host,
        props,
        targetRowId: targetMessage.id,
      });
      expect(
        Math.abs(afterCollapse.actualHeightPx - afterCollapse.virtualizerSizePx),
      ).toBeLessThanOrEqual(8);
    } finally {
      await mounted.cleanup();
    }
  });
});
