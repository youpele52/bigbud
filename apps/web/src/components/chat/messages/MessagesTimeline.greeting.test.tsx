import { MessageId } from "@bigbud/contracts/core/baseSchemas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessagesTimeline } from "./MessagesTimeline";
import type { MessagesTimelineProps } from "./MessagesTimeline.shared";

const props: MessagesTimelineProps = {
  emptyChatGreeting: "What’s up next, Youpele?",
  isWorking: false,
  activeTurnInProgress: false,
  activeTurnStartedAt: null,
  scrollContainer: null,
  timelineEntries: [],
  completionDividerBeforeEntryId: null,
  completionSummary: null,
  turnDiffSummaryByAssistantMessageId: new Map(),
  nowIso: "2026-10-11T09:00:00.000Z",
  expandedWorkGroups: {},
  onToggleWorkGroup: () => {},
  activityAccordionOpenById: {},
  onSetActivityAccordionOpen: () => {},
  changedFilesExpandedByTurnId: {},
  onSetChangedFilesExpanded: () => {},
  onOpenTurnDiff: () => {},
  revertTurnCountByUserMessageId: new Map(),
  onRevertUserMessage: () => {},
  isRevertingCheckpoint: false,
  onImageExpand: () => {},
  markdownCwd: undefined,
  resolvedTheme: "light",
  timestampFormat: "locale",
  workspaceRoot: undefined,
};

describe("empty timeline greeting", () => {
  it("renders the greeting only inside a truly empty, idle conversation", () => {
    expect(renderToStaticMarkup(<MessagesTimeline {...props} />)).toContain(
      "What’s up next, Youpele?",
    );
    expect(renderToStaticMarkup(<MessagesTimeline {...props} shimmerEmptyChat />)).toContain(
      "chat-greeting-mark-shimmer",
    );
    expect(renderToStaticMarkup(<MessagesTimeline {...props} isWorking />)).not.toContain(
      "What’s up next",
    );
    expect(
      renderToStaticMarkup(<MessagesTimeline {...props} emptyChatGreeting={null} />),
    ).not.toContain("<p ");
  });

  it("never renders greeting copy over persisted messages or as a transcript entry", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          {
            id: "existing-message",
            kind: "message",
            createdAt: props.nowIso,
            message: {
              id: MessageId.makeUnsafe("existing-message"),
              role: "user",
              text: "A saved conversation",
              createdAt: props.nowIso,
              streaming: false,
            },
          },
        ]}
      />,
    );
    expect(markup).toContain("A saved conversation");
    expect(markup).not.toContain("What’s up next");
    expect(props.timelineEntries).toEqual([]);
  });
});
