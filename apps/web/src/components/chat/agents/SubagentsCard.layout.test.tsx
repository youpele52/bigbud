import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OrchestrationTask } from "@bigbud/contracts";
import {
  insertHistoricalSubagentRows,
  type MessagesTimelineRow,
} from "../messages/MessagesTimeline.logic";
import { MessagesTimelineWorkGroup } from "../messages/MessagesTimeline.workGroup";
import { CHAT_COLUMN_CLASS_NAME } from "../common/chatColumn";
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

function workRow(groupedEntries: unknown[]): never {
  return {
    kind: "work",
    id: "work",
    createdAt: "2026-09-28T12:00:00.000Z",
    groupedEntries,
  } as never;
}

/** Header actions are a sibling after details, outside its collapsible panel. */
function headerActions(markup: string): string {
  const start = markup.indexOf('data-slot="activity-accordion-actions"');
  return start < 0 ? "" : markup.slice(start);
}

function accordionPanel(markup: string): string {
  const start = markup.indexOf('data-slot="activity-accordion-panel"');
  return markup.slice(start, markup.indexOf("</details>", start));
}

describe("compact Subagents presentation", () => {
  it("keeps the live section open with a right-aligned overflow toggle", () => {
    const subagents = renderToStaticMarkup(
      <SubagentsCard
        agents={[{ ...agent("one"), progressSummary: "Reviewing UI components" }, agent("two")]}
      />,
    );
    expect(subagents).toContain('data-variant="section"');
    expect(subagents).toMatch(/<details[^>]*\sopen=""/);
    expect(subagents).toContain("border-b border-border/60");
    expect(subagents).not.toContain("rounded-xl border border-border/45 bg-card/25");
    expect(subagents).toContain("Subagents (2)");
    expect(subagents).toContain("Show 1 more");
    expect(headerActions(subagents)).toContain("Show 1 more");
    expect(accordionPanel(subagents)).not.toContain("Show 1 more");
    expect(subagents.match(/text-xs/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(subagents).toContain("text-[9px]");
    expect(subagents).toContain("sm:text-[9px]");
    expect(subagents).toContain("data-agent-working-blob");
    expect(subagents).toContain("--agent-blob-working:var(--subagent)");
    expect(subagents).toContain("text-blue-600 dark:text-blue-400");
    expect(subagents).toContain(">working<");
  });

  it("renders timeline history as a collapsed accordion sharing the live card body", () => {
    const agents = [agent("one", false), agent("two", false)];
    const history = renderToStaticMarkup(
      <SubagentsCard agents={agents} presentation="accordion" />,
    );
    const live = renderToStaticMarkup(<SubagentsCard agents={agents} />);
    expect(history).toContain('aria-label="Subagents"');
    expect(history).toMatch(/<details data-slot="activity-accordion" data-variant="section"/);
    expect(history).not.toMatch(/<details[^>]*\sopen=""/);
    expect(history).toContain("Subagents (2)");
    expect(history).not.toContain("rounded-xl border border-border/45 bg-card/25");
    // The overflow toggle is a sibling after details, outside the collapsible panel.
    expect(headerActions(history)).toContain("Show 1 more");
    const panel = accordionPanel(history);
    expect(panel).toContain('data-subagent-row="one"');
    expect(panel).not.toContain("Show 1 more");
    expect(live).toContain('data-subagent-row="one"');
  });

  it("puts work-log overflow in the accordion header and groups a lone tool call too", () => {
    const workLog = renderToStaticMarkup(
      <MessagesTimelineWorkGroup
        row={workRow([
          { id: "one", tone: "info", label: "One" },
          { id: "two", tone: "info", label: "Two" },
        ])}
        isExpanded={false}
        onToggleWorkGroup={() => {}}
        executionTargetId={undefined}
      />,
    );
    expect(workLog).toMatch(/<details data-slot="activity-accordion" data-variant="section"/);
    expect(workLog).toContain("Work log (2)");
    expect(headerActions(workLog)).toContain("Show 1 more");
    expect(accordionPanel(workLog)).not.toContain("Show 1 more");
    expect(workLog).not.toContain("rounded-xl border border-border/45 bg-card/25");

    const single = renderToStaticMarkup(
      <MessagesTimelineWorkGroup
        row={workRow([{ id: "tool", tone: "tool", label: "Read file" }])}
        isExpanded={false}
        onToggleWorkGroup={() => {}}
        executionTargetId={undefined}
      />,
    );
    expect(single).toMatch(/<details data-slot="activity-accordion" data-variant="section"/);
    expect(single).toContain("Tool calls (1)");
    expect(headerActions(single)).toContain('title="Copy message"');
    expect(headerActions(single)).not.toContain("Show 1 more");
    expect(accordionPanel(single)).toContain("Read file");
    expect(accordionPanel(single)).not.toContain('title="Copy message"');
    expect(single).not.toContain("group-hover/work-log:opacity-100");
  });

  it("keeps the live card in the shared conversation column used by timeline rows", () => {
    const markup = renderToStaticMarkup(<ChatAgentActivityFeed agents={[agent("live")]} />);
    expect(markup).toContain(`class="${CHAT_COLUMN_CLASS_NAME}"`);
    expect(markup).not.toContain("mt-2 mb-8");
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
    expect(activeMarkup).toContain(`class="${CHAT_COLUMN_CLASS_NAME}"`);
    expect(activeMarkup).not.toContain("mb-8");
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
