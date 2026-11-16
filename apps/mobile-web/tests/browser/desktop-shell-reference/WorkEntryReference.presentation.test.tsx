import type { WorkLogEntry } from "@bigbud/shared/workLog";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SimpleWorkEntryRow } from "~/components/chat/messages/MessagesTimeline.workEntry";
import { MobileWorkLogEntry } from "../../../src/components/threads/thread/MobileWorkLogEntry";

const entry: WorkLogEntry = {
  id: "fixture-detail",
  createdAt: "2026-11-16T00:00:00.000Z",
  label: "Command completed",
  tone: "tool",
  itemType: "command_execution",
  command: "printf 'fixture only'",
  rawCommand: "sh -lc \"printf 'fixture only'\"",
  detail: "Fixture output line one\nFixture output line two",
};

describe("actual current desktop/mobile work-entry details", () => {
  it("exposes full raw command and hidden output through a real local disclosure", () => {
    const desktop = renderToStaticMarkup(
      <SimpleWorkEntryRow workEntry={entry} showActions={false} />,
    );
    const mobile = renderToStaticMarkup(<MobileWorkLogEntry entry={entry} />);
    for (const markup of [desktop, mobile]) {
      expect(markup).toContain("<details");
      expect(markup).toContain("<summary");
      expect(markup).toContain("data-work-entry-details");

      expect(markup).not.toMatch(/<details[^>]*\sopen=""/);
    }
    expect(desktop).toContain("Fixture output line one\nFixture output line two</pre>");
    expect(mobile).not.toContain("<pre");
    expect(mobile).toContain("min-h-11");
  });

  it("keeps short single-line previews compact when no detail is hidden", () => {
    const short: WorkLogEntry = {
      id: "fixture-short",
      createdAt: entry.createdAt,
      label: entry.label,
      tone: "tool",
      itemType: "command_execution",
      command: "git status",
    };
    const desktop = renderToStaticMarkup(
      <SimpleWorkEntryRow workEntry={short} showActions={false} />,
    );
    const mobile = renderToStaticMarkup(<MobileWorkLogEntry entry={short} />);
    expect(desktop).not.toContain("data-work-entry-details");
    expect(mobile).not.toContain("data-work-entry-details");
  });
});
