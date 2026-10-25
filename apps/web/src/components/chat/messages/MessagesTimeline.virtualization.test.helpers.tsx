import { type TurnId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { useCallback, useState, type ComponentProps } from "react";
import { expect, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import { estimateMessagesTimelineRowHeight } from "./MessagesTimeline.estimate";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

export const DEFAULT_VIEWPORT = {
  width: 960,
  height: 1_100,
};

export interface RowMeasurement {
  actualHeightPx: number;
  estimatedHeightPx: number;
  timelineWidthPx: number;
  virtualizerSizePx: number;
  renderedInVirtualizedRegion: boolean;
}

export interface VirtualizationScenario {
  name: string;
  targetRowId: string;
  props: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">;
  maxEstimateDeltaPx: number;
}

export interface VirtualizerSnapshot {
  totalSize: number;
  measurements: ReadonlyArray<{
    id: string;
    kind: string;
    index: number;
    size: number;
    start: number;
    end: number;
  }>;
}

export function MessagesTimelineBrowserHarness(
  props: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">,
) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>(
    () => props.expandedWorkGroups,
  );
  const [activityAccordionOpenById, setActivityAccordionOpenById] = useState<
    Record<string, boolean>
  >(() => props.activityAccordionOpenById);
  const [changedFilesExpandedByTurnId, setChangedFilesExpandedByTurnId] = useState<
    Record<string, boolean>
  >(() => props.changedFilesExpandedByTurnId);
  const handleToggleWorkGroup = useCallback(
    (groupId: string) => {
      setExpandedWorkGroups((current) => ({
        ...current,
        [groupId]: !(current[groupId] ?? false),
      }));
      props.onToggleWorkGroup(groupId);
    },
    [props],
  );
  const handleSetActivityAccordionOpen = useCallback(
    (accordionId: string, open: boolean) => {
      setActivityAccordionOpenById((current) => ({ ...current, [accordionId]: open }));
      props.onSetActivityAccordionOpen(accordionId, open);
    },
    [props],
  );
  const handleSetChangedFilesExpanded = useCallback(
    (turnId: TurnId, expanded: boolean) => {
      setChangedFilesExpandedByTurnId((current) => ({
        ...current,
        [turnId]: expanded,
      }));
      props.onSetChangedFilesExpanded(turnId, expanded);
    },
    [props],
  );

  return (
    <div
      ref={setScrollContainer}
      data-testid="messages-timeline-scroll-container"
      className="h-full overflow-y-auto overscroll-y-contain"
    >
      <MessagesTimeline
        {...props}
        scrollContainer={scrollContainer}
        expandedWorkGroups={expandedWorkGroups}
        onToggleWorkGroup={handleToggleWorkGroup}
        activityAccordionOpenById={activityAccordionOpenById}
        onSetActivityAccordionOpen={handleSetActivityAccordionOpen}
        changedFilesExpandedByTurnId={changedFilesExpandedByTurnId}
        onSetChangedFilesExpanded={handleSetChangedFilesExpanded}
      />
    </div>
  );
}

export async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

export async function setViewport(viewport: { width: number; height: number }): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

export async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    { timeout: 4_000, interval: 16 },
  );
}

export async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    { timeout: 8_000, interval: 16 },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

export async function measureTimelineRow(input: {
  host: HTMLElement;
  props: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">;
  targetRowId: string;
}): Promise<RowMeasurement> {
  const scrollContainer = await waitForElement(
    () =>
      input.host.querySelector<HTMLDivElement>(
        '[data-testid="messages-timeline-scroll-container"]',
      ),
    "Unable to find MessagesTimeline scroll container.",
  );

  const rowSelector = `[data-timeline-row-id="${input.targetRowId}"]`;
  const virtualRowSelector = `[data-virtual-row-id="${input.targetRowId}"]`;

  let timelineWidthPx = 0;
  let actualHeightPx = 0;
  let virtualizerSizePx = 0;
  let renderedInVirtualizedRegion = false;

  await vi.waitFor(
    async () => {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();

      const rowElement = input.host.querySelector<HTMLElement>(rowSelector);
      const virtualRowElement = input.host.querySelector<HTMLElement>(virtualRowSelector);
      const timelineRoot = input.host.querySelector<HTMLElement>('[data-timeline-root="true"]');

      expect(rowElement, "Unable to locate target timeline row.").toBeTruthy();
      expect(virtualRowElement, "Unable to locate target virtualized wrapper.").toBeTruthy();
      expect(timelineRoot, "Unable to locate MessagesTimeline root.").toBeTruthy();

      timelineWidthPx = timelineRoot!.getBoundingClientRect().width;
      actualHeightPx = rowElement!.getBoundingClientRect().height;
      virtualizerSizePx = Number.parseFloat(virtualRowElement!.dataset.virtualRowSize ?? "0");
      renderedInVirtualizedRegion = virtualRowElement!.hasAttribute("data-index");

      expect(timelineWidthPx).toBeGreaterThan(0);
      expect(actualHeightPx).toBeGreaterThan(0);
      expect(virtualizerSizePx).toBeGreaterThan(0);
      expect(renderedInVirtualizedRegion).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );

  const rows = deriveMessagesTimelineRows({
    timelineEntries: input.props.timelineEntries,
    completionDividerBeforeEntryId: input.props.completionDividerBeforeEntryId,
    isWorking: input.props.isWorking,
    activeTurnStartedAt: input.props.activeTurnStartedAt,
    ...(input.props.historicalAgents ? { historicalAgents: input.props.historicalAgents } : {}),
  });
  const targetRow = rows.find((row) => row.id === input.targetRowId);
  expect(targetRow, `Unable to derive target row ${input.targetRowId}.`).toBeTruthy();

  return {
    actualHeightPx,
    estimatedHeightPx: estimateMessagesTimelineRowHeight(targetRow!, {
      expandedWorkGroups: input.props.expandedWorkGroups,
      activityAccordionOpenById: input.props.activityAccordionOpenById,
      timelineWidthPx,
      turnDiffSummaryByAssistantMessageId: input.props.turnDiffSummaryByAssistantMessageId,
    }),
    timelineWidthPx,
    virtualizerSizePx,
    renderedInVirtualizedRegion,
  };
}

export async function mountMessagesTimeline(input: {
  props: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">;
  viewport?: { width: number; height: number };
}) {
  const viewport = input.viewport ?? DEFAULT_VIEWPORT;
  await setViewport(viewport);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.width = `${viewport.width}px`;
  host.style.minWidth = `${viewport.width}px`;
  host.style.maxWidth = `${viewport.width}px`;
  host.style.height = `${viewport.height}px`;
  host.style.minHeight = `${viewport.height}px`;
  host.style.maxHeight = `${viewport.height}px`;
  host.style.display = "block";
  host.style.overflow = "hidden";
  document.body.append(host);

  const screen = await render(<MessagesTimelineBrowserHarness {...input.props} />, {
    container: host,
  });
  await waitForLayout();

  return {
    host,
    rerender: async (
      nextProps: Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer">,
    ) => {
      await screen.rerender(<MessagesTimelineBrowserHarness {...nextProps} />);
      await waitForLayout();
    },
    setContainerSize: async (nextViewport: { width: number; height: number }) => {
      await setViewport(nextViewport);
      host.style.width = `${nextViewport.width}px`;
      host.style.minWidth = `${nextViewport.width}px`;
      host.style.maxWidth = `${nextViewport.width}px`;
      host.style.height = `${nextViewport.height}px`;
      host.style.minHeight = `${nextViewport.height}px`;
      host.style.maxHeight = `${nextViewport.height}px`;
      await waitForLayout();
    },
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

export async function measureRenderedRowActualHeight(input: {
  host: HTMLElement;
  targetRowId: string;
}): Promise<number> {
  const rowElement = await waitForElement(
    () => input.host.querySelector<HTMLElement>(`[data-timeline-row-id="${input.targetRowId}"]`),
    `Unable to locate rendered row ${input.targetRowId}.`,
  );
  return rowElement.getBoundingClientRect().height;
}
