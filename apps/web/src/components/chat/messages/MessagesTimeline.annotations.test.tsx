import { MessageId } from "@bigbud/contracts";
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

describe("MessagesTimeline annotations", () => {
  it("renders sent browser annotations as a compact expandable attachment", async () => {
    const annotation = [
      "Browser annotation",
      "",
      "User instruction:",
      "Fix this button",
      "",
      "Page:",
      "Title: Dashboard",
      "URL: https://example.com/dashboard",
      "Viewport: width=1280 height=720 devicePixelRatio=2",
      "",
      "Selected element:",
      "Selector: #save",
      "Tag: button",
      "Role: button",
      "Text: Save",
      "Aria label: Save changes",
      "Rect: x=10 y=20 width=100 height=32",
      "",
      "Use the attached screenshot and selected element metadata to make the appropriate code change.",
    ].join("\n");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-annotation-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-annotation-1"),
              role: "user",
              text: `Please inspect\n\n${annotation}\n\n---\n\n${annotation}`,
              createdAt: "2026-03-17T19:12:28.000Z",
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

    expect(markup).toContain("2 annotations");
    expect(markup).toContain("Please inspect");
    expect(markup).toContain("Fix this button");
    expect(markup).toContain("border-border/80 bg-background");
    expect(markup).toContain("text-info");
    expect(markup).not.toContain("bg-info/10");
    expect(markup.indexOf("Please inspect")).toBeGreaterThan(markup.indexOf("Browser annotation"));
    expect(markup).not.toContain("<span>Please inspect\n\nBrowser annotation");
  });

  it("renders sent code annotations as a compact expandable attachment", async () => {
    const annotation = [
      "Code annotation",
      "",
      "User instruction:",
      "Extract this into a helper",
      "",
      "File:",
      "Project: bigbud",
      "Workspace: /Users/youpele/DevWorld/bigbud",
      "Path: apps/web/src/main.ts",
      "Lines: 20-22",
      "",
      "Selected code:",
      "```",
      "const value = createValue();",
      "```",
      "",
      "Use the selected code and user instruction to make the appropriate code change.",
    ].join("\n");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-code-annotation-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-code-annotation-1"),
              role: "user",
              text: `Please inspect\n\n${annotation}`,
              createdAt: "2026-03-17T19:12:28.000Z",
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

    expect(markup).toContain("1 annotation");
    expect(markup).toContain("Extract this into a helper");
    expect(markup).toContain("bigbud &gt; apps/web/src/main.ts");
    expect(markup).toContain("Lines 20-22");
    expect(markup).toContain("const value = createValue();");
    expect(markup).toContain("Please inspect");
    expect(markup).toContain("text-info");
    expect(markup).not.toContain("Use the selected code and user instruction");
    expect(markup).not.toContain("<span>Please inspect\n\nCode annotation");
  });
});
