import "../../../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { answeredQuestion, historicalSubagents } from "./MessagesTimeline.accordion.scenarios";
import {
  createBaseTimelineProps,
  createChangedFilesSummary,
  createMessage,
  createToolWorkEntry,
  isoAt,
} from "./MessagesTimeline.virtualization.test.fixtures";
import {
  mountMessagesTimeline,
  waitForLayout,
} from "./MessagesTimeline.virtualization.test.helpers";
import { SubagentsCard } from "../agents/SubagentsCard";

it("gives successive collapsed process types one 16px boundary and no action footer", async () => {
  const props = createBaseTimelineProps({
    workEntries: [
      createToolWorkEntry({ id: "tool", offsetSeconds: 1 }),
      {
        id: "thinking",
        createdAt: isoAt(2),
        label: "Thinking",
        detail: "Planning",
        tone: "thinking",
      },
      { ...createToolWorkEntry({ id: "log", offsetSeconds: 3 }), tone: "info" },
    ],
    answeredUserInputs: [answeredQuestion()],
    historicalAgents: historicalSubagents(),
  });
  const mounted = await mountMessagesTimeline({ props });
  try {
    await waitForLayout();
    const rows = [...mounted.host.querySelectorAll<HTMLElement>("[data-timeline-row-id]")];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const [index, row] of rows.entries()) {
      const details = row.querySelector<HTMLDetailsElement>('details[data-variant="section"]')!;
      expect(details.open).toBe(false);
      const box = details.getBoundingClientRect();
      expect(row.getBoundingClientRect().bottom - box.bottom).toBeCloseTo(16, 1);
      expect(box.top).toBeCloseTo(row.getBoundingClientRect().top, 1);
      const next = rows[index + 1];
      if (next) expect(next.getBoundingClientRect().top - box.bottom).toBeCloseTo(16, 1);
    }
  } finally {
    await mounted.cleanup();
  }
});

it("puts the stable assistant footer before Changed files, with the same boundary on either side", async () => {
  const message = createMessage({
    id: "changed-boundary",
    role: "assistant",
    text: "Done.",
    offsetSeconds: 0,
  });
  const props = createBaseTimelineProps({
    messages: [message],
    turnDiffSummaryByAssistantMessageId: createChangedFilesSummary(message.id, [
      { path: "a.ts", additions: 1, deletions: 0 },
    ]),
    workEntries: [createToolWorkEntry({ id: "following-tool", offsetSeconds: 4 })],
  });
  const mounted = await mountMessagesTimeline({ props });
  try {
    await waitForLayout();
    const row = mounted.host.querySelector<HTMLElement>('[data-message-id="changed-boundary"]')!;
    const footer = row.querySelector<HTMLElement>('[data-message-footer="assistant"]')!;
    const messageBlock = footer.parentElement!.parentElement!;
    const changed = row.querySelector<HTMLDetailsElement>('details[data-variant="section"]')!;
    const following = mounted.host.querySelector<HTMLElement>(
      '[data-timeline-row-id="following-tool"]',
    )!;
    expect(footer.compareDocumentPosition(changed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      changed.getBoundingClientRect().top - messageBlock.getBoundingClientRect().bottom,
    ).toBeCloseTo(16, 1);
    expect(
      following.getBoundingClientRect().top - changed.getBoundingClientRect().bottom,
    ).toBeCloseTo(16, 1);
    const height = row.getBoundingClientRect().height;
    footer.querySelector<HTMLButtonElement>("button")!.focus();
    await waitForLayout();
    expect(row.getBoundingClientRect().height).toBe(height);
  } finally {
    await mounted.cleanup();
  }
});

it("uses the historical header and panel rhythm for live subagents without losing controls", async () => {
  const agents = historicalSubagents();
  const screen = await render(
    <div>
      <div data-testid="history">
        <SubagentsCard agents={agents} presentation="accordion" />
      </div>
      <div data-testid="live">
        <SubagentsCard agents={agents} />
      </div>
    </div>,
  );
  const history = screen.getByTestId("history").element().querySelector("details")!;
  const live = screen.getByTestId("live").element().querySelector("details")!;
  expect(history.open).toBe(false);
  expect(live.open).toBe(true);
  for (const property of ["paddingTop", "paddingBottom", "fontSize", "letterSpacing"] as const) {
    expect(getComputedStyle(live.querySelector("summary")!)[property]).toBe(
      getComputedStyle(history.querySelector("summary")!)[property],
    );
  }
  expect(
    getComputedStyle(live.querySelector<HTMLElement>('[data-slot="activity-accordion-panel"]')!)
      .paddingTop,
  ).toBe("12px");
});
