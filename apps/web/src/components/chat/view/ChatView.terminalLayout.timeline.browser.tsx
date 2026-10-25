import "../../../index.css";

import { useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ChatLayoutMenu } from "../common/ChatHeader.layoutMenu";
import { MessagesTimeline } from "../messages/MessagesTimeline";
import {
  createBaseTimelineProps,
  createMessage,
} from "../messages/MessagesTimeline.virtualization.test.fixtures";
import {
  setViewport,
  waitForElement,
  waitForLayout,
  waitForProductionStyles,
} from "../messages/MessagesTimeline.virtualization.test.helpers";
import type { ChatReaderPosition } from "../scroller/chatScroll.constants";
import { useTerminalLayout } from "./chat-view/terminalLayout.hooks";

const ANCHOR_ID = "layout-history-user-10";
// Subpixel layout and integer scrollTop rounding may differ by at most one CSS pixel.
const POSITION_TOLERANCE_PX = 1;

function TimelineLayoutHarness({
  timelineProps,
}: {
  timelineProps: ReturnType<typeof createBaseTimelineProps>;
}) {
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const toggleTerminalVisibility = useCallback(() => setTerminalOpen((open) => !open), []);
  const layout = useTerminalLayout({
    activeThreadId: "timeline-layout",
    terminalOpen,
    setTerminalOpen,
    toggleTerminalVisibility,
  });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="shrink-0">
        <ChatLayoutMenu mode={layout.mode} onSelectLayout={layout.selectLayout} />
      </header>
      <div
        data-chat-body-region
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        hidden={!layout.chatVisible}
        inert={!layout.chatVisible || undefined}
      >
        <div
          ref={setScrollContainer}
          data-layout-history-scroll
          className="h-full min-h-0 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4 [scrollbar-gutter:stable]"
        >
          <MessagesTimeline {...timelineProps} scrollContainer={scrollContainer} />
        </div>
      </div>
      <div
        data-layout-terminal={layout.terminalPresentation}
        hidden={!terminalOpen || layout.terminalPresentation === "hidden"}
        className={layout.terminalPresentation === "fill" ? "min-h-0 flex-1" : "h-60 shrink-0"}
      >
        Terminal presentation
      </div>
    </div>
  );
}

function createVariableHeightHistory() {
  return Array.from({ length: 40 }, (_, index) => [
    createMessage({
      id: `layout-history-user-${index}`,
      role: "user",
      text: Array.from(
        { length: 3 + (index % 6) },
        (_, line) =>
          `Historical question ${index}, line ${line}: preserve this reader's place when switching layouts.`,
      ).join("\n"),
      offsetSeconds: index * 4,
    }),
    createMessage({
      id: `layout-history-assistant-${index}`,
      role: "assistant",
      text: [
        `## Historical response ${index}`,
        Array.from({ length: 1 + (index % 4) }, () =>
          "This is a completed historical answer with wrapping prose and variable rendered height. ".repeat(
            3,
          ),
        ).join("\n\n"),
        "| Check | Result |\n| --- | --- |\n| Session | Running |\n| Reader | Preserved |",
        Array.from({ length: 2 + (index % 5) }, (_, line) => `- Historical detail ${line}`).join(
          "\n",
        ),
      ].join("\n\n"),
      offsetSeconds: index * 4 + 1,
    }),
  ]).flat();
}

async function selectLayout(label: string) {
  await page.getByRole("button", { name: "Chat layout", exact: true }).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  // Allow both the hidden container's ResizeObserver and the virtualizer's frame queue to run.
  await waitForLayout();
  await waitForLayout();
}

async function waitForMeasuredRows(host: HTMLElement) {
  await vi.waitFor(
    () => {
      const rows = Array.from(
        host.querySelectorAll<HTMLElement>("[data-virtual-row-id][data-index]"),
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(
          Math.abs(Number(row.dataset.virtualRowSize) - row.getBoundingClientRect().height),
        ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
      }
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

function anchorOffset(host: HTMLElement, scrollContainer: HTMLElement) {
  const anchor = host.querySelector<HTMLElement>(`[data-timeline-row-id="${ANCHOR_ID}"]`);
  expect(anchor, "The historical message anchor must remain mounted and visible").toBeTruthy();
  const anchorRect = anchor!.getBoundingClientRect();
  const scrollRect = scrollContainer.getBoundingClientRect();
  expect(anchorRect.bottom).toBeGreaterThan(scrollRect.top);
  expect(anchorRect.top).toBeLessThan(scrollRect.bottom);
  return anchorRect.top - scrollRect.top;
}

describe("terminal layout with the real historical timeline", () => {
  it.each(["Chat + terminal", "Chat only"])(
    "preserves the measured reader anchor when restoring %s",
    async (restoredLayout) => {
      await setViewport({ width: 900, height: 800 });
      await waitForProductionStyles();
      const observed: { readerPosition: ChatReaderPosition | null } = { readerPosition: null };
      const historicalSizes = new Map<string, number>();
      const timelineProps = {
        ...createBaseTimelineProps({
          messages: createVariableHeightHistory(),
        }),
        onReaderPositionChange: (position: ChatReaderPosition) => {
          observed.readerPosition = position;
        },
      };
      const host = document.createElement("div");
      host.style.width = "640px";
      host.style.height = "720px";
      host.style.overflow = "hidden";
      document.body.append(host);
      const screen = await render(<TimelineLayoutHarness timelineProps={timelineProps} />, {
        container: host,
      });
      try {
        const scrollContainer = await waitForElement(
          () => host.querySelector<HTMLDivElement>("[data-layout-history-scroll]"),
          "Unable to find the historical timeline scroll container.",
        );
        await waitForMeasuredRows(host);

        // Visit the prefix before reading row 20, so restoring must preserve real cached heights,
        // not just reproduce the same estimates for never-measured offscreen history.
        for (const index of [4, 8, 12, 16, 20]) {
          // Each next user row is within the real virtualizer's eight-row overscan.
          const row = await waitForElement(
            () =>
              host.querySelector<HTMLElement>(
                `[data-virtual-row-id="layout-history-user-${index / 2}"][data-index]`,
              ),
            `Historical row ${index} was not virtualized.`,
          );
          scrollContainer.scrollTop +=
            row.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
          scrollContainer.dispatchEvent(new Event("scroll"));
          await waitForMeasuredRows(host);
          for (const measured of host.querySelectorAll<HTMLElement>(
            "[data-virtual-row-id][data-index]",
          )) {
            historicalSizes.set(
              measured.dataset.virtualRowId!,
              measured.getBoundingClientRect().height,
            );
          }
        }

        const anchor = host.querySelector<HTMLElement>(`[data-timeline-row-id="${ANCHOR_ID}"]`)!;
        scrollContainer.scrollTop +=
          anchor.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top + 24;
        scrollContainer.dispatchEvent(new Event("scroll"));
        await waitForMeasuredRows(host);
        await waitForLayout();
        // Publish from the settled, real measurement cache, not a fixture-derived reader position.
        scrollContainer.dispatchEvent(new Event("scroll"));
        const baselineTop = scrollContainer.scrollTop;
        const baselineOffset = anchorOffset(host, scrollContainer);
        const baselineReader = observed.readerPosition!;
        const baselineWidth = host
          .querySelector<HTMLElement>('[data-timeline-root="true"]')!
          .getBoundingClientRect().width;
        expect(baselineTop).toBeGreaterThan(1000);
        expect(
          scrollContainer.scrollHeight - baselineTop - scrollContainer.clientHeight,
        ).toBeGreaterThan(1000);
        expect(baselineReader.currentAnchorMessageId).toBe(ANCHOR_ID);
        expect(baselineReader.visibleMessageIds).toContain(ANCHOR_ID);
        expect(historicalSizes.size).toBeGreaterThan(20);
        expect(
          Math.max(...historicalSizes.values()) - Math.min(...historicalSizes.values()),
        ).toBeGreaterThan(80);

        const assertReaderPreserved = (sameViewport: boolean) => {
          expect(Math.abs(scrollContainer.scrollTop - baselineTop)).toBeLessThanOrEqual(
            POSITION_TOLERANCE_PX,
          );
          expect(
            Math.abs(anchorOffset(host, scrollContainer) - baselineOffset),
          ).toBeLessThanOrEqual(POSITION_TOLERANCE_PX);
          expect(
            host.querySelector<HTMLElement>('[data-timeline-root="true"]')!.getBoundingClientRect()
              .width,
          ).toBe(baselineWidth);
          scrollContainer.dispatchEvent(new Event("scroll"));
          expect(observed.readerPosition!.currentAnchorMessageId).toBe(
            baselineReader.currentAnchorMessageId,
          );
          expect(observed.readerPosition!.visibleMessageIds).toContain(ANCHOR_ID);
          if (sameViewport)
            expect(observed.readerPosition!.visibleMessageIds).toEqual(
              baselineReader.visibleMessageIds,
            );
        };

        for (let cycle = 0; cycle < 2; cycle += 1) {
          await selectLayout("Terminal only");
          expect(host.querySelector<HTMLElement>("[data-chat-body-region]")!.hidden).toBe(true);
          expect(
            host.querySelector<HTMLElement>('[data-timeline-root="true"]')!.getBoundingClientRect()
              .width,
          ).toBe(0);
          await selectLayout(restoredLayout);
          await waitForMeasuredRows(host);
          assertReaderPreserved(restoredLayout === "Chat + terminal");
          if (restoredLayout === "Chat only") {
            await selectLayout("Chat + terminal");
            await waitForMeasuredRows(host);
            assertReaderPreserved(true);
          }
          await waitForLayout();
          assertReaderPreserved(true);
        }
      } finally {
        await screen.unmount();
        host.remove();
      }
    },
  );
});
