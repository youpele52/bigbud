import "../../../index.css";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answeredQuestion, buildAccordionScenarios } from "./MessagesTimeline.accordion.scenarios";
import {
  createBaseTimelineProps,
  createFillerMessages,
  createToolWorkEntry,
  isoAt,
} from "./MessagesTimeline.virtualization.test.fixtures";
import {
  DEFAULT_VIEWPORT,
  measureTimelineRow,
  mountMessagesTimeline,
  setViewport,
  waitForElement,
} from "./MessagesTimeline.virtualization.test.helpers";

describe("MessagesTimeline accordion row estimates", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await setViewport(DEFAULT_VIEWPORT);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each(buildAccordionScenarios())(
    "keeps the $name estimate within tolerance",
    async (scenario) => {
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
    },
  );

  it("aligns every accordion row and its open panel on one left edge", async () => {
    const thinking = (id: string, offsetSeconds: number) => ({
      id,
      createdAt: isoAt(offsetSeconds),
      label: "Thinking",
      detail: "Planning the next step.",
      tone: "thinking" as const,
    });
    const props = createBaseTimelineProps({
      messages: createFillerMessages({ prefix: "align", startOffsetSeconds: 0, pairCount: 1 }),
      workEntries: [
        thinking("align-thinking-a", 10),
        createToolWorkEntry({ id: "align-tool", offsetSeconds: 11 }),
        thinking("align-thinking-b", 12),
        { ...createToolWorkEntry({ id: "align-log-0", offsetSeconds: 13 }), tone: "info" },
        createToolWorkEntry({ id: "align-log-1", offsetSeconds: 14 }),
      ],
      answeredUserInputs: [answeredQuestion()],
      activityAccordionOpenById: { "thinking:align-thinking-a": true },
    });
    const mounted = await mountMessagesTimeline({ props });
    try {
      const panel = await waitForElement(
        () =>
          mounted.host.querySelector<HTMLElement>(
            '[data-timeline-row-id="align-thinking-a"] [data-slot="activity-accordion-panel"]',
          ),
        "Unable to find the open thinking panel.",
      );
      const accordions = [
        ...mounted.host.querySelectorAll<HTMLDetailsElement>(
          '[data-timeline-row-id] details[data-slot="activity-accordion"][data-variant="section"]',
        ),
      ];
      expect(accordions.length).toBeGreaterThanOrEqual(5);
      const edges = accordions.map((details) => {
        const box = details.getBoundingClientRect();
        const summary = details.querySelector("summary")!.getBoundingClientRect();
        return { left: box.left, right: box.right, summaryLeft: summary.left };
      });
      for (const edge of edges) {
        expect(edge.left).toBeCloseTo(edges[0]!.left, 1);
        expect(edge.right).toBeCloseTo(edges[0]!.right, 1);
        expect(edge.summaryLeft).toBeCloseTo(edges[0]!.left, 1);
      }
      // Panel content stays flush with the header; there is no horizontal inset.
      const panelStyle = getComputedStyle(panel);
      expect(panelStyle.paddingLeft).toBe("0px");
      expect(panelStyle.paddingRight).toBe("0px");
      expect(panel.getBoundingClientRect().left).toBeCloseTo(edges[0]!.left, 1);
    } finally {
      await mounted.cleanup();
    }
  });
});
