import { MessageId } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MessagesTimelineDelegatedProvenance } from "./MessagesTimeline.delegatedProvenance";

vi.mock("../common/ChatMarkdown", () => ({
  default: ({ text, className }: { text: string; className?: string }) => (
    <div className={className}>{text}</div>
  ),
}));

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
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: { classList, offsetHeight: 0 },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

beforeAll(async () => {
  ({ MessagesTimeline } = await import("./MessagesTimeline"));
});

describe("MessagesTimelineDelegatedProvenance", () => {
  it("renders readable provenance in closed native details", () => {
    const body = "Parent thread: Parent task (thread-parent)\nDelegation: delegation-1";
    const markup = renderToStaticMarkup(
      <MessagesTimelineDelegatedProvenance provenance={{ body }} />,
    );

    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("Delegation details");
    expect(markup).toContain("max-h-64");
    expect(markup).toContain("Parent thread: Parent task (thread-parent)");
  });

  it("renders delegation details immediately before the task without raw tags", () => {
    const prompt = [
      "<delegated_thread_provenance>",
      "Parent thread: Parent task (thread-parent)",
      "Parent project: project-parent",
      "Delegation: delegation-1",
      "</delegated_thread_provenance>",
      "",
      "Implement the delegated task exactly.",
    ].join("\n");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        scrollContainer={null}
        timelineEntries={[
          {
            id: "entry-delegated-1",
            kind: "message",
            createdAt: "2026-07-29T12:00:00.000Z",
            message: {
              id: MessageId.makeUnsafe("message-delegated-1"),
              role: "user",
              text: prompt,
              createdAt: "2026-07-29T12:00:00.000Z",
              streaming: false,
            },
          },
        ]}
        completionDividerBeforeEntryId={null}
        completionSummary={null}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-07-29T12:00:01.000Z"
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

    expect(markup).not.toContain("delegated_thread_provenance");
    expect(markup.indexOf("Delegation details")).toBeLessThan(
      markup.indexOf("Implement the delegated task exactly."),
    );
  });
});
