import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OrchestrationTask } from "@bigbud/contracts";
import {
  insertHistoricalSubagentRows,
  type MessagesTimelineRow,
} from "../messages/MessagesTimeline.logic";
import { MessagesTimelineWorkGroup } from "../messages/MessagesTimeline.workGroup";
import { ChatAgentActivityFeed } from "./ChatAgentActivityFeed";
import { SubagentsCard } from "./SubagentsCard";

function agent(id: string, fresh = true): OrchestrationTask {
  return {
    id: id as never,
    kind: "providerSubagent",
    nativeId: id,
    activityFresh: fresh,
    status: fresh ? "inProgress" : "completed",
    subject: id,
    source: "observed",
    freshness: { sessionEpoch: "1", sourcePriority: 1, observedOrdinal: 1 },
    createdAt: "2026-09-28T12:00:00.000Z",
    updatedAt: "2026-09-28T12:00:01.000Z",
  };
}

function messageRow(id: string, turnId: string, createdAt: string): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt,
    message: {
      id,
      role: id.includes("user") ? "user" : "assistant",
      text: id,
      turnId,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
    } as never,
    durationStart: createdAt,
    showCompletionDivider: false,
    showAssistantCopyButton: true,
  };
}

describe("compact Subagents presentation", () => {
  it("shares the compact Work log shell and right-aligned overflow presentation", () => {
    const subagents = renderToStaticMarkup(
      <SubagentsCard
        agents={[{ ...agent("one"), progressSummary: "Reviewing UI components" }, agent("two")]}
      />,
    );
    const workLog = renderToStaticMarkup(
      <MessagesTimelineWorkGroup
        row={
          {
            kind: "work",
            id: "work",
            createdAt: "2026-09-28T12:00:00.000Z",
            groupedEntries: [
              { id: "one", tone: "status", label: "One" },
              { id: "two", tone: "status", label: "Two" },
            ],
          } as never
        }
        isExpanded={false}
        onToggleWorkGroup={() => {}}
        executionTargetId={undefined}
      />,
    );
    const shell = "rounded-xl border border-border/45 bg-card/25 px-2 py-1.5";
    expect(subagents).toContain(shell);
    expect(workLog).toContain(shell);
    expect(subagents).toContain("Subagents (2)");
    expect(workLog).toContain("Work log (2)");
    expect(subagents).toContain("Show 1 more");
    expect(workLog).toContain("Show 1 more");
    expect(subagents).toContain("items-center justify-between");
    expect(workLog).toContain("items-center justify-between");
    expect(subagents.match(/text-xs/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("anchors completion to its turn before later user and assistant messages", () => {
    const activeAgent = { ...agent("live"), turnId: "turn-1" as never };
    const completedAgent = {
      ...activeAgent,
      status: "completed" as const,
      activityFresh: false,
      updatedAt: "2026-09-28T12:02:00.000Z",
    };
    const activeMarkup = renderToStaticMarkup(<ChatAgentActivityFeed agents={[activeAgent]} />);
    expect(activeMarkup).toContain('data-agent-feed-placement="timeline-end"');
    expect(activeMarkup).toContain("mb-8");
    expect(activeMarkup).not.toContain("violet");
    expect(renderToStaticMarkup(<ChatAgentActivityFeed agents={[completedAgent]} />)).toBe("");

    const rows = [
      messageRow("user-1", "turn-1", "2026-09-28T12:00:00.000Z"),
      messageRow("assistant-1", "turn-1", "2026-09-28T12:00:04.000Z"),
      messageRow("later-user", "turn-2", "2026-09-28T12:01:00.000Z"),
      messageRow("later-assistant", "turn-2", "2026-09-28T12:01:05.000Z"),
    ];
    insertHistoricalSubagentRows(rows, [completedAgent]);
    expect(rows.map((row) => row.id)).toEqual([
      "user-1",
      "assistant-1",
      "subagents-history:turn:turn-1",
      "later-user",
      "later-assistant",
    ]);
  });
});
