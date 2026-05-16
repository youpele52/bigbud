import { MessageId } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessagesTimeline } from "./MessagesTimeline";

describe("MessagesTimeline work log layout", () => {
  it("renders single-entry work log actions outside the bordered card", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-work-actions-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-actions-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Provider turn start failed",
              detail: "Remote OpenCode CLI is not installed or not available on PATH.",
              tone: "error",
            },
          },
          {
            id: "message-anchor-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-anchor-1"),
              role: "assistant",
              text: "anchor",
              createdAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        changedFilesExpandedByTurnId={{}}
        onSetChangedFilesExpanded={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("group/work-log flex flex-col items-start gap-1");
    expect(markup).toContain(
      "px-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/work-log:opacity-100",
    );
    expect(markup).not.toContain("mt-1.5 flex justify-start pl-6");
  });
});
