import { MessageId, type TurnId } from "@bigbud/contracts";
import { page } from "vitest/browser";
import { useCallback, useState, type ComponentProps } from "react";
import { expect, vi } from "vitest";
import { render } from "vitest-browser-react";

import { deriveTimelineEntries } from "../../../logic/session";
import { type WorkLogEntry } from "../../../logic/session";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../../models/types";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  deriveMessagesTimelineRows,
  estimateMessagesTimelineRowHeight,
} from "./MessagesTimeline.logic";

export const DEFAULT_VIEWPORT = {
  width: 960,
  height: 1_100,
};
export const MARKDOWN_CWD = "/repo/project";

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
        changedFilesExpandedByTurnId={changedFilesExpandedByTurnId}
        onSetChangedFilesExpanded={handleSetChangedFilesExpanded}
      />
    </div>
  );
}

export function isoAt(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 2, 17, 19, 12, 28) + offsetSeconds * 1_000).toISOString();
}

export function createMessage(input: {
  id: string;
  role: ChatMessage["role"];
  text: string;
  offsetSeconds: number;
  attachments?: ChatMessage["attachments"];
}): ChatMessage {
  return {
    id: MessageId.makeUnsafe(input.id),
    role: input.role,
    text: input.text,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    createdAt: isoAt(input.offsetSeconds),
    ...(input.role === "assistant" ? { completedAt: isoAt(input.offsetSeconds + 1) } : {}),
    streaming: false,
  };
}

export function createToolWorkEntry(input: {
  id: string;
  offsetSeconds: number;
  label?: string;
  detail?: string;
}): WorkLogEntry {
  return {
    id: input.id,
    createdAt: isoAt(input.offsetSeconds),
    label: input.label ?? "exec_command completed",
    ...(input.detail ? { detail: input.detail } : {}),
    tone: "tool",
    toolTitle: "exec_command",
  };
}

export function createPlan(input: {
  id: string;
  offsetSeconds: number;
  planMarkdown: string;
}): ProposedPlan {
  return {
    id: input.id as ProposedPlan["id"],
    turnId: null,
    planMarkdown: input.planMarkdown,
    implementedAt: null,
    implementationThreadId: null,
    createdAt: isoAt(input.offsetSeconds),
    updatedAt: isoAt(input.offsetSeconds + 1),
  };
}

export function createBaseTimelineProps(input: {
  messages?: ChatMessage[];
  proposedPlans?: ProposedPlan[];
  workEntries?: WorkLogEntry[];
  expandedWorkGroups?: Record<string, boolean>;
  completionDividerBeforeEntryId?: string | null;
  turnDiffSummaryByAssistantMessageId?: Map<MessageId, TurnDiffSummary>;
  onVirtualizerSnapshot?: ComponentProps<typeof MessagesTimeline>["onVirtualizerSnapshot"];
}): Omit<ComponentProps<typeof MessagesTimeline>, "scrollContainer"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    timelineEntries: deriveTimelineEntries(
      input.messages ?? [],
      input.proposedPlans ?? [],
      input.workEntries ?? [],
    ),
    completionDividerBeforeEntryId: input.completionDividerBeforeEntryId ?? null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: input.turnDiffSummaryByAssistantMessageId ?? new Map(),
    nowIso: isoAt(10_000),
    expandedWorkGroups: input.expandedWorkGroups ?? {},
    onToggleWorkGroup: () => {},
    changedFilesExpandedByTurnId: {},
    onSetChangedFilesExpanded: () => {},
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: MARKDOWN_CWD,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: MARKDOWN_CWD,
    ...(input.onVirtualizerSnapshot ? { onVirtualizerSnapshot: input.onVirtualizerSnapshot } : {}),
  };
}

export function createFillerMessages(input: {
  prefix: string;
  startOffsetSeconds: number;
  pairCount: number;
}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < input.pairCount; index += 1) {
    const baseOffset = input.startOffsetSeconds + index * 4;
    messages.push(
      createMessage({
        id: `${input.prefix}-user-${index}`,
        role: "user",
        text: `filler user message ${index}`,
        offsetSeconds: baseOffset,
      }),
    );
    messages.push(
      createMessage({
        id: `${input.prefix}-assistant-${index}`,
        role: "assistant",
        text: `filler assistant message ${index}`,
        offsetSeconds: baseOffset + 1,
      }),
    );
  }
  return messages;
}

export function createChangedFilesSummary(
  targetMessageId: MessageId,
  files: TurnDiffSummary["files"],
): Map<MessageId, TurnDiffSummary> {
  return new Map([
    [
      targetMessageId,
      {
        turnId: "turn-changed-files" as TurnId,
        completedAt: isoAt(10),
        assistantMessageId: targetMessageId,
        files,
      },
    ],
  ]);
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
  });
  const targetRow = rows.find((row) => row.id === input.targetRowId);
  expect(targetRow, `Unable to derive target row ${input.targetRowId}.`).toBeTruthy();

  return {
    actualHeightPx,
    estimatedHeightPx: estimateMessagesTimelineRowHeight(targetRow!, {
      expandedWorkGroups: input.props.expandedWorkGroups,
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
