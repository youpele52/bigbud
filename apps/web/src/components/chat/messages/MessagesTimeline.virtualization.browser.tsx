import "../../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildStaticScenarios } from "./MessagesTimeline.virtualization.scenarios";
import {
  DEFAULT_VIEWPORT,
  createBaseTimelineProps,
  createChangedFilesSummary,
  createFillerMessages,
  createMessage,
  createToolWorkEntry,
  measureRenderedRowActualHeight,
  measureTimelineRow,
  mountMessagesTimeline,
  setViewport,
  waitForElement,
  waitForLayout,
  type VirtualizerSnapshot,
} from "./MessagesTimeline.virtualization.test.helpers";

describe("MessagesTimeline virtualization harness", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await setViewport(DEFAULT_VIEWPORT);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each(buildStaticScenarios())("keeps the $name estimate within tolerance", async (scenario) => {
    const mounted = await mountMessagesTimeline({ props: scenario.props });

    try {
      const measurement = await measureTimelineRow({
        host: mounted.host,
        props: scenario.props,
        targetRowId: scenario.targetRowId,
      });

      expect(
        Math.abs(measurement.actualHeightPx - measurement.estimatedHeightPx),
        `estimate delta for ${scenario.name}`,
      ).toBeLessThanOrEqual(scenario.maxEstimateDeltaPx);
    } finally {
      await mounted.cleanup();
    }
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
        { path: ".plans/effect-atom.md", additions: 89, deletions: 0 },
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
      const beforeCollapse = await measureTimelineRow({
        host: mounted.host,
        props,
        targetRowId: targetMessage.id,
      });
      const targetRowElement = mounted.host.querySelector<HTMLElement>(
        `[data-timeline-row-id="${targetMessage.id}"]`,
      );
      expect(targetRowElement, "Unable to locate target changed-files row.").toBeTruthy();

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

  it("keeps the work-log row virtualizer size in sync after show more expands the group", async () => {
    const beforeMessages = createFillerMessages({
      prefix: "before-worklog-expand",
      startOffsetSeconds: 0,
      pairCount: 2,
    });
    const afterMessages = createFillerMessages({
      prefix: "after-worklog-expand",
      startOffsetSeconds: 40,
      pairCount: 8,
    });
    const workEntries = Array.from({ length: 10 }, (_, index) =>
      createToolWorkEntry({
        id: `target-work-toggle-${index}`,
        offsetSeconds: 12 + index,
        detail: `tool output line ${index + 1}`,
      }),
    );
    const props = createBaseTimelineProps({
      messages: [...beforeMessages, ...afterMessages],
      workEntries,
    });
    const mounted = await mountMessagesTimeline({ props });

    try {
      const beforeExpand = await measureTimelineRow({
        host: mounted.host,
        props,
        targetRowId: workEntries[0]!.id,
      });
      const targetRowElement = mounted.host.querySelector<HTMLElement>(
        `[data-timeline-row-id="${workEntries[0]!.id}"]`,
      );
      expect(targetRowElement, "Unable to locate target work-log row.").toBeTruthy();

      const showMoreButton =
        Array.from(targetRowElement!.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
          button.textContent?.includes("Show 4 more"),
        ) ?? null;
      expect(showMoreButton, 'Unable to find "Show more" button.').toBeTruthy();

      showMoreButton!.click();

      await vi.waitFor(
        async () => {
          const afterExpand = await measureTimelineRow({
            host: mounted.host,
            props,
            targetRowId: workEntries[0]!.id,
          });
          expect(afterExpand.actualHeightPx).toBeGreaterThan(beforeExpand.actualHeightPx + 72);
        },
        { timeout: 8_000, interval: 16 },
      );

      const afterExpand = await measureTimelineRow({
        host: mounted.host,
        props,
        targetRowId: workEntries[0]!.id,
      });
      expect(
        Math.abs(afterExpand.actualHeightPx - afterExpand.virtualizerSizePx),
      ).toBeLessThanOrEqual(8);
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves measured tail row heights when rows transition into virtualization", async () => {
    const beforeMessages = createFillerMessages({
      prefix: "tail-transition-before",
      startOffsetSeconds: 0,
      pairCount: 1,
    });
    const afterMessages = createFillerMessages({
      prefix: "tail-transition-after",
      startOffsetSeconds: 40,
      pairCount: 3,
    });
    const targetMessage = createMessage({
      id: "target-tail-transition",
      role: "assistant",
      text: "Validation passed on the merged tree.",
      offsetSeconds: 12,
    });
    let latestSnapshot: VirtualizerSnapshot | null = null;
    const initialProps = createBaseTimelineProps({
      messages: [...beforeMessages, targetMessage, ...afterMessages],
      turnDiffSummaryByAssistantMessageId: createChangedFilesSummary(targetMessage.id, [
        { path: ".plans/effect-atom.md", additions: 89, deletions: 0 },
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
      onVirtualizerSnapshot: (snapshot) => {
        latestSnapshot = {
          totalSize: snapshot.totalSize,
          measurements: snapshot.measurements,
        };
      },
    });

    const mounted = await mountMessagesTimeline({ props: initialProps });

    try {
      const initiallyRenderedHeight = await measureRenderedRowActualHeight({
        host: mounted.host,
        targetRowId: targetMessage.id,
      });

      const appendedProps = createBaseTimelineProps({
        messages: [
          ...beforeMessages,
          targetMessage,
          ...afterMessages,
          ...createFillerMessages({
            prefix: "tail-transition-extra",
            startOffsetSeconds: 120,
            pairCount: 8,
          }),
        ],
        turnDiffSummaryByAssistantMessageId: initialProps.turnDiffSummaryByAssistantMessageId,
        onVirtualizerSnapshot: initialProps.onVirtualizerSnapshot,
      });
      await mounted.rerender(appendedProps);

      const scrollContainer = await waitForElement(
        () =>
          mounted.host.querySelector<HTMLDivElement>(
            '[data-testid="messages-timeline-scroll-container"]',
          ),
        "Unable to find MessagesTimeline scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      await vi.waitFor(
        () => {
          const measurement = latestSnapshot?.measurements.find(
            (entry) => entry.id === targetMessage.id,
          );
          expect(
            measurement,
            "Expected target row to transition into virtualizer cache.",
          ).toBeTruthy();
          expect(Math.abs((measurement?.size ?? 0) - initiallyRenderedHeight)).toBeLessThanOrEqual(
            8,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("preserves measured tail image row heights when rows transition into virtualization", async () => {
    const beforeMessages = createFillerMessages({
      prefix: "tail-image-before",
      startOffsetSeconds: 0,
      pairCount: 1,
    });
    const afterMessages = createFillerMessages({
      prefix: "tail-image-after",
      startOffsetSeconds: 40,
      pairCount: 3,
    });
    const targetMessage = createMessage({
      id: "target-tail-image-transition",
      role: "user",
      text: "Here is a narrow screenshot.",
      offsetSeconds: 12,
      attachments: [
        {
          type: "image",
          id: "target-tail-image",
          name: "narrow.svg",
          mimeType: "image/svg+xml",
          sizeBytes: 512,
          previewUrl:
            "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='72'%3E%3Crect width='240' height='72' fill='%23dbeafe'/%3E%3C/svg%3E",
        },
      ],
    });
    let latestSnapshot: VirtualizerSnapshot | null = null;
    const initialProps = createBaseTimelineProps({
      messages: [...beforeMessages, targetMessage, ...afterMessages],
      onVirtualizerSnapshot: (snapshot) => {
        latestSnapshot = {
          totalSize: snapshot.totalSize,
          measurements: snapshot.measurements,
        };
      },
    });
    const mounted = await mountMessagesTimeline({ props: initialProps });

    try {
      await vi.waitFor(
        () => {
          const image = mounted.host.querySelector<HTMLImageElement>(
            `[data-timeline-row-id="${targetMessage.id}"] img`,
          );
          expect(image?.naturalHeight ?? 0).toBeGreaterThan(0);
        },
        { timeout: 8_000, interval: 16 },
      );

      const initiallyRenderedHeight = await measureRenderedRowActualHeight({
        host: mounted.host,
        targetRowId: targetMessage.id,
      });
      const appendedProps = createBaseTimelineProps({
        messages: [
          ...beforeMessages,
          targetMessage,
          ...afterMessages,
          ...createFillerMessages({
            prefix: "tail-image-extra",
            startOffsetSeconds: 120,
            pairCount: 8,
          }),
        ],
        onVirtualizerSnapshot: initialProps.onVirtualizerSnapshot,
      });
      await mounted.rerender(appendedProps);

      const scrollContainer = await waitForElement(
        () =>
          mounted.host.querySelector<HTMLDivElement>(
            '[data-testid="messages-timeline-scroll-container"]',
          ),
        "Unable to find MessagesTimeline scroll container.",
      );
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      await vi.waitFor(
        () => {
          const measurement = latestSnapshot?.measurements.find(
            (entry) => entry.id === targetMessage.id,
          );
          expect(
            measurement,
            "Expected target image row to transition into virtualizer cache.",
          ).toBeTruthy();
          expect(Math.abs((measurement?.size ?? 0) - initiallyRenderedHeight)).toBeLessThanOrEqual(
            8,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
