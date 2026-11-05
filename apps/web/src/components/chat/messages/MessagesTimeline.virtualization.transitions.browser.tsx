import "../../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBaseTimelineProps,
  createFillerMessages,
  createMessage,
  createToolWorkEntry,
} from "./MessagesTimeline.virtualization.test.fixtures";
import {
  DEFAULT_VIEWPORT,
  measureTimelineRow,
  mountMessagesTimeline,
  setViewport,
  waitForElement,
  waitForLayout,
  type VirtualizerSnapshot,
} from "./MessagesTimeline.virtualization.test.helpers";

describe("MessagesTimeline measurement transitions", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await setViewport(DEFAULT_VIEWPORT);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("observes a timeline created after the empty greeting and sizes rows across resize round trips", async () => {
    const target = createMessage({
      id: "appearing-timeline-long-message",
      role: "user",
      text: "A response with enough words to wrap in a narrow window. ".repeat(12),
      offsetSeconds: 1,
    });
    const props = createBaseTimelineProps({
      messages: [
        target,
        ...createFillerMessages({
          prefix: "appearing-timeline-after",
          startOffsetSeconds: 40,
          pairCount: 12,
        }),
      ],
    });
    const mounted = await mountMessagesTimeline({
      props: createBaseTimelineProps({ messages: [] }),
    });
    try {
      expect(mounted.host.querySelector('[data-timeline-root="true"]')).toBeNull();
      await mounted.rerender(props);
      const wide = await measureTimelineRow({ host: mounted.host, props, targetRowId: target.id });
      expect(Math.abs(wide.actualHeightPx - wide.virtualizerSizePx)).toBeLessThanOrEqual(8);

      await mounted.setContainerSize({ width: 320, height: DEFAULT_VIEWPORT.height });
      await vi.waitFor(async () => {
        const narrow = await measureTimelineRow({
          host: mounted.host,
          props,
          targetRowId: target.id,
        });
        expect(narrow.timelineWidthPx).toBeLessThan(wide.timelineWidthPx - 200);
        expect(narrow.actualHeightPx).toBeGreaterThan(wide.actualHeightPx + 40);
        expect(Math.abs(narrow.actualHeightPx - narrow.virtualizerSizePx)).toBeLessThanOrEqual(8);
      });

      await mounted.setContainerSize(DEFAULT_VIEWPORT);
      await vi.waitFor(async () => {
        const restored = await measureTimelineRow({
          host: mounted.host,
          props,
          targetRowId: target.id,
        });
        expect(Math.abs(restored.actualHeightPx - wide.actualHeightPx)).toBeLessThanOrEqual(8);
        expect(Math.abs(restored.actualHeightPx - restored.virtualizerSizePx)).toBeLessThanOrEqual(
          8,
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("updates offscreen row sizes when a newly appeared timeline resizes", async () => {
    const target = createMessage({
      id: "offscreen-width-transition",
      role: "user",
      text: "An offscreen line needs the real wrapping width. ".repeat(24),
      offsetSeconds: 60,
    });
    const messages = [
      ...createFillerMessages({ prefix: "offscreen-before", startOffsetSeconds: 0, pairCount: 12 }),
      target,
      ...createFillerMessages({ prefix: "offscreen-after", startOffsetSeconds: 80, pairCount: 12 }),
    ];
    let latestSnapshot: VirtualizerSnapshot | null = null;
    const props = createBaseTimelineProps({
      messages,
      onVirtualizerSnapshot: (snapshot) => {
        latestSnapshot = snapshot;
      },
    });
    const viewport = { width: DEFAULT_VIEWPORT.width, height: 320 };
    const mounted = await mountMessagesTimeline({
      props: createBaseTimelineProps({ messages: [] }),
      viewport,
    });
    try {
      await mounted.rerender(props);
      const rowSize = () => latestSnapshot?.measurements.find(({ id }) => id === target.id)?.size;
      await vi.waitFor(() => expect(rowSize()).toBeGreaterThan(0));
      expect(mounted.host.querySelector(`[data-virtual-row-id="${target.id}"]`)).toBeNull();
      const wideSize = rowSize()!;

      await mounted.setContainerSize({ width: 320, height: viewport.height });
      await vi.waitFor(() => expect(rowSize()).toBeGreaterThan(wideSize + 40));
      expect(mounted.host.querySelector(`[data-virtual-row-id="${target.id}"]`)).toBeNull();

      await mounted.setContainerSize(viewport);
      await vi.waitFor(() => expect(Math.abs(rowSize()! - wideSize)).toBeLessThanOrEqual(8));
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not reuse a collapsed tail height after its accordion opens and moves into virtualization", async () => {
    const workEntries = Array.from({ length: 10 }, (_, index) =>
      createToolWorkEntry({
        id: `tail-accordion-work-${index}`,
        offsetSeconds: 12 + index,
        detail: `tool output line ${index + 1}`,
      }),
    );
    const initialMessages = createFillerMessages({
      prefix: "tail-accordion-before",
      startOffsetSeconds: 0,
      pairCount: 3,
    });
    const laterMessages = createFillerMessages({
      prefix: "tail-accordion-after",
      startOffsetSeconds: 40,
      pairCount: 12,
    });
    let latestSnapshot: VirtualizerSnapshot | null = null;
    const onVirtualizerSnapshot = (snapshot: VirtualizerSnapshot) => {
      latestSnapshot = snapshot;
    };
    const initialProps = createBaseTimelineProps({
      messages: initialMessages,
      workEntries,
      onVirtualizerSnapshot,
    });
    const mounted = await mountMessagesTimeline({ props: initialProps });
    try {
      const targetId = workEntries[0]!.id;
      const row = await waitForElement(
        () => mounted.host.querySelector<HTMLElement>(`[data-timeline-row-id="${targetId}"]`),
        "Unable to locate the tail work row.",
      );
      expect(mounted.host.querySelector(`[data-virtual-row-id="${targetId}"]`)).toBeNull();
      const collapsedHeight = row.getBoundingClientRect().height;
      row
        .querySelector("details > summary")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => {
        expect(row.getBoundingClientRect().height).toBeGreaterThan(collapsedHeight + 24);
      });
      const expandedHeight = row.getBoundingClientRect().height;
      await waitForLayout();

      const appendedProps = createBaseTimelineProps({
        messages: [...initialMessages, ...laterMessages],
        workEntries,
        onVirtualizerSnapshot,
      });
      await mounted.rerender(appendedProps);
      await vi.waitFor(() => {
        const measured = latestSnapshot?.measurements.find(({ id }) => id === targetId);
        expect(measured, "Expected the former tail row in the virtualizer cache.").toBeTruthy();
        expect(Math.abs(measured!.size - expandedHeight)).toBeLessThanOrEqual(8);
      });

      const virtualized = await measureTimelineRow({
        host: mounted.host,
        props: appendedProps,
        targetRowId: targetId,
      });
      expect(
        Math.abs(virtualized.actualHeightPx - virtualized.virtualizerSizePx),
      ).toBeLessThanOrEqual(8);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps observing the same tail elements while streaming updates their content", async () => {
    const NativeResizeObserver = window.ResizeObserver;
    let tailObservations = 0;
    let tailDisconnects = 0;
    window.ResizeObserver = class extends NativeResizeObserver {
      override observe(target: Element, options?: ResizeObserverOptions) {
        if (target.hasAttribute("data-tail-measurement-key")) tailObservations += 1;
        super.observe(target, options);
      }

      override disconnect() {
        tailDisconnects += 1;
        super.disconnect();
      }
    };
    const messages = createFillerMessages({
      prefix: "streaming-tail",
      startOffsetSeconds: 0,
      pairCount: 3,
    });
    const target = messages.at(-1)!;
    let mounted: Awaited<ReturnType<typeof mountMessagesTimeline>> | null = null;
    try {
      mounted = await mountMessagesTimeline({ props: createBaseTimelineProps({ messages }) });
      expect(tailObservations).toBeGreaterThan(0);
      const initialObservations = tailObservations;
      const initialDisconnects = tailDisconnects;
      for (let index = 0; index < 5; index += 1) {
        await mounted.rerender(
          createBaseTimelineProps({
            messages: [...messages.slice(0, -1), { ...target, text: `${target.text} ${index}` }],
          }),
        );
      }
      expect(tailObservations).toBe(initialObservations);
      expect(tailDisconnects).toBe(initialDisconnects);
    } finally {
      window.ResizeObserver = NativeResizeObserver;
      await mounted?.cleanup();
    }
  });
});
