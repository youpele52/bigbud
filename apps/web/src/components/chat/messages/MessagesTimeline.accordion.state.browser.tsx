import "../../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type WorkLogEntry } from "../../../logic/session";
import { answeredQuestion } from "./MessagesTimeline.accordion.scenarios";
import {
  createBaseTimelineProps,
  createFillerMessages,
  createToolWorkEntry,
  isoAt,
} from "./MessagesTimeline.virtualization.test.fixtures";
import {
  DEFAULT_VIEWPORT,
  mountMessagesTimeline,
  setViewport,
  waitForElement,
  waitForLayout,
} from "./MessagesTimeline.virtualization.test.helpers";

const QUESTION_ROW_ID = "user-input-question:request-accordion";

function rowDetails(host: HTMLElement, rowId: string): HTMLDetailsElement | null {
  return host.querySelector<HTMLDetailsElement>(
    `[data-timeline-row-id="${rowId}"] details[data-slot="activity-accordion"]`,
  );
}

async function clickSummary(details: HTMLDetailsElement) {
  details.querySelector("summary")!.click();
  await waitForLayout();
}

const liveWork = (): WorkLogEntry[] => [
  { ...createToolWorkEntry({ id: "live-work-0", offsetSeconds: 12 }), tone: "info" },
  createToolWorkEntry({ id: "live-work-1", offsetSeconds: 13 }),
];

const thinking: WorkLogEntry = {
  id: "live-thinking",
  createdAt: isoAt(12),
  label: "Thinking",
  detail: "Weighing the persisted accordion state.",
  tone: "thinking",
};

function turnProps(input: {
  live: boolean;
  workEntries: WorkLogEntry[];
  onSetActivityAccordionOpen?: (id: string, open: boolean) => void;
}) {
  return {
    ...createBaseTimelineProps({
      messages: createFillerMessages({ prefix: "turn", startOffsetSeconds: 0, pairCount: 2 }),
      workEntries: input.workEntries,
      isWorking: input.live,
      activeTurnStartedAt: input.live ? isoAt(11) : null,
    }),
    ...(input.onSetActivityAccordionOpen
      ? { onSetActivityAccordionOpen: input.onSetActivityAccordionOpen }
      : {}),
  };
}

describe("MessagesTimeline persisted accordion state", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await setViewport(DEFAULT_VIEWPORT);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps an answered question open after its virtualized row unmounts and remounts", async () => {
    const props = createBaseTimelineProps({
      messages: [
        ...createFillerMessages({ prefix: "before", startOffsetSeconds: 0, pairCount: 2 }),
        ...createFillerMessages({ prefix: "after", startOffsetSeconds: 40, pairCount: 40 }),
      ],
      answeredUserInputs: [answeredQuestion()],
    });
    const viewport = { width: DEFAULT_VIEWPORT.width, height: 320 };
    const mounted = await mountMessagesTimeline({ props, viewport });
    try {
      const scroller = await waitForElement(
        () =>
          mounted.host.querySelector<HTMLElement>(
            '[data-testid="messages-timeline-scroll-container"]',
          ),
        "Unable to find the scroll container.",
      );
      const scrollTo = async (top: number) => {
        scroller.scrollTop = top;
        scroller.dispatchEvent(new Event("scroll"));
        await waitForLayout();
      };
      await scrollTo(0);
      const details = await waitForElement(
        () => rowDetails(mounted.host, QUESTION_ROW_ID),
        "Unable to find the answered question accordion.",
      );
      expect(details.open).toBe(false);
      await clickSummary(details);
      await vi.waitFor(() => expect(rowDetails(mounted.host, QUESTION_ROW_ID)?.open).toBe(true));

      await scrollTo(scroller.scrollHeight);
      await vi.waitFor(() => expect(rowDetails(mounted.host, QUESTION_ROW_ID)).toBeNull());

      await scrollTo(0);
      const remounted = await waitForElement(
        () => rowDetails(mounted.host, QUESTION_ROW_ID),
        "The answered question row did not remount.",
      );
      expect(remounted).not.toBe(details);
      expect(remounted.open).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps live work collapsed by default while the turn runs and after it finishes", async () => {
    const onSetOpen = vi.fn();
    const mounted = await mountMessagesTimeline({
      props: turnProps({
        live: true,
        workEntries: liveWork(),
        onSetActivityAccordionOpen: onSetOpen,
      }),
    });
    try {
      const live = await waitForElement(
        () => rowDetails(mounted.host, "live-work-0"),
        "Unable to find the live work log accordion.",
      );
      expect(live.querySelector("summary")?.textContent).toContain("Work log (2)");
      await waitForLayout();
      expect(live.open).toBe(false);

      await mounted.rerender(
        turnProps({ live: false, workEntries: liveWork(), onSetActivityAccordionOpen: onSetOpen }),
      );
      expect(rowDetails(mounted.host, "live-work-0")?.open).toBe(false);
      expect(onSetOpen).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("stores an explicit toggle once and ignores the toggles React applies itself", async () => {
    const onSetOpen = vi.fn();
    const props = (live: boolean) =>
      turnProps({ live, workEntries: [thinking], onSetActivityAccordionOpen: onSetOpen });
    const mounted = await mountMessagesTimeline({ props: props(true) });
    try {
      const streaming = await waitForElement(
        () => rowDetails(mounted.host, "live-thinking"),
        "Unable to find the thinking accordion.",
      );
      await waitForLayout();
      expect(streaming.open).toBe(false);
      await clickSummary(streaming);
      await vi.waitFor(() =>
        expect(onSetOpen).toHaveBeenLastCalledWith("thinking:live-thinking", true),
      );
      // Rerendering after the turn finishes must not report anything new: only the user's
      // click is a toggle worth storing.
      await mounted.rerender(props(false));
      await waitForLayout();
      expect(onSetOpen).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });
});
