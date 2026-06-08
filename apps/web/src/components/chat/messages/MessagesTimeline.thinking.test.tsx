import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../common/ChatMarkdown", () => ({
  default: ({ text, className }: { text: string; className?: string }) => (
    <div className={className}>{text}</div>
  ),
}));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

let MessagesTimeline: (typeof import("./MessagesTimeline"))["MessagesTimeline"];

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

beforeAll(async () => {
  ({ MessagesTimeline } = await import("./MessagesTimeline"));
});

describe("MessagesTimeline work and thinking entries", () => {
  it("renders context compaction entries in the normal work log", async () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
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

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("renders thinking entries as chat-style markdown blocks instead of work-log rows", async () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "thinking-entry-1",
            kind: "thinking",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "thinking-work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Thinking",
              detail: "Checking the current thread state",
              tone: "thinking",
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

    expect(markup).toContain("Thinking");
    expect(markup).toContain("Checking the current thread state");
    expect(markup).toContain("thinking-markdown");
    expect(markup).toContain("text-xs");
    expect(markup).toContain("text-muted-foreground/68");
    expect(markup).not.toContain("Work log");
  });

  it("collapses long thinking entries by default", async () => {
    const detail = `${"Checking the current thread state. ".repeat(24)}Final sentence.`;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "thinking-entry-long",
            kind: "thinking",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "thinking-work-long",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Thinking",
              detail,
              tone: "thinking",
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

    expect(markup).toContain("Expand thinking");
    expect(markup).not.toContain("Final sentence.");
  });
});
