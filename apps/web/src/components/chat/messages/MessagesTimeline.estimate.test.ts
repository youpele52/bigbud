import { describe, expect, it, vi } from "vitest";

import { type WorkLogEntry } from "../../../logic/session";
import {
  isTimelineRowAccordionOpen,
  timelineRowAccordionControl,
  timelineRowAccordionId,
} from "./MessagesTimeline.accordion";
import { estimateMessagesTimelineRowHeight } from "./MessagesTimeline.estimate";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";

const createdAt = "2026-01-01T00:00:01Z";
const entry = (id: string, overrides: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
  id,
  createdAt,
  label: "Ran command",
  tone: "tool",
  ...overrides,
});
const workRow = (entries: WorkLogEntry[]): MessagesTimelineRow => ({
  kind: "work",
  id: "work-1",
  createdAt,
  groupedEntries: entries,
});
const thinkingRow = (streaming: boolean): MessagesTimelineRow => ({
  kind: "thinking",
  id: "thinking-1",
  createdAt,
  entry: entry("thinking-1", { tone: "thinking", label: "Thinking", detail: "Planning." }),
  streaming,
});
const estimate = (row: MessagesTimelineRow, openById: Record<string, boolean> = {}) =>
  estimateMessagesTimelineRowHeight(row, {
    timelineWidthPx: 768,
    activityAccordionOpenById: openById,
  });

describe("timeline accordion state", () => {
  it("namespaces ids by kind, giving even a single tool call an accordion", () => {
    expect(timelineRowAccordionId(workRow([entry("a"), entry("b")]))).toBe("work:work-1");
    expect(timelineRowAccordionId(workRow([entry("a")]))).toBe("work:work-1");
    expect(timelineRowAccordionId(thinkingRow(false))).toBe("thinking:thinking-1");
  });

  it("keeps every accordion collapsed, even while live, until a stored toggle opens it", () => {
    const work = workRow([entry("a"), entry("b")]);
    expect(isTimelineRowAccordionOpen(work, {})).toBe(false);
    expect(isTimelineRowAccordionOpen(thinkingRow(true), {})).toBe(false);
    expect(isTimelineRowAccordionOpen(work, { "work:work-1": true })).toBe(true);
    expect(isTimelineRowAccordionOpen(thinkingRow(true), { "thinking:thinking-1": true })).toBe(
      true,
    );
  });

  it("stores only toggles that disagree with the rendered state", () => {
    const onSetOpen = vi.fn();
    const control = timelineRowAccordionControl(thinkingRow(true), {}, onSetOpen)!;
    const toggle = (open: boolean) =>
      control.onToggle({ currentTarget: { open } } as Parameters<typeof control.onToggle>[0]);
    expect(control.open).toBe(false);
    toggle(false);
    expect(onSetOpen).not.toHaveBeenCalled();
    toggle(true);
    expect(onSetOpen).toHaveBeenCalledExactlyOnceWith("thinking:thinking-1", true);
  });
});

describe("accordion row height estimates", () => {
  it("sizes collapsed accordions as a header and open ones with their panel", () => {
    const finishedWork = workRow([entry("a"), entry("b"), entry("c")]);
    expect(estimate(finishedWork)).toBe(80);
    expect(estimate(finishedWork, { "work:work-1": true })).toBe(128);
    expect(estimate(thinkingRow(false))).toBe(56);
    expect(estimate(thinkingRow(true))).toBe(56);
    expect(estimate(thinkingRow(false), { "thinking:thinking-1": true })).toBeGreaterThan(56);
  });

  it("adds the work-entry Details toggle and its open panel", () => {
    const command = "git log --oneline --graph --decorate --all --max-count=200 -- apps/web/src";
    const withDetails = workRow([entry("a", { command: `${command} --stat` })]);
    const plain = workRow([entry("a", { command: "ls" })]);
    const open = { "work:work-1": true };
    expect(estimate(withDetails)).toBe(estimate(plain));
    expect(estimate(withDetails, open) - estimate(plain, open)).toBe(15);
    expect(estimate(withDetails, { ...open, "work-entry:a": true })).toBeGreaterThan(
      estimate(withDetails, open),
    );
  });
});
