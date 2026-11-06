import { describe, expect, it } from "vitest";

import { changedFilesAccordionId } from "./MessagesTimeline.accordion";
import { estimateMessagesTimelineRowHeight } from "./MessagesTimeline.estimate";
import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  createChangedFilesSummary,
  createMessage,
} from "./MessagesTimeline.virtualization.test.fixtures";

const message = createMessage({
  id: "assistant-changed-files",
  role: "assistant",
  text: "Done.",
  offsetSeconds: 1,
});
const row: MessagesTimelineRow = {
  kind: "message",
  id: message.id,
  createdAt: message.createdAt,
  message,
  durationStart: message.createdAt,
  showCompletionDivider: false,
  showAssistantCopyButton: true,
};
const turnDiffSummaryByAssistantMessageId = createChangedFilesSummary(message.id, [
  { path: "apps/server/src/a.ts", additions: 2, deletions: 2 },
  { path: "packages/shared/src/b.ts", additions: 8, deletions: 1 },
]);
const turnId = turnDiffSummaryByAssistantMessageId.get(message.id)!.turnId;

const estimate = (input: { withFiles: boolean; openById?: Record<string, boolean> }) =>
  estimateMessagesTimelineRowHeight(row, {
    timelineWidthPx: 768,
    activityAccordionOpenById: input.openById ?? {},
    ...(input.withFiles ? { turnDiffSummaryByAssistantMessageId } : {}),
  });

describe("assistant changed files accordion", () => {
  it("namespaces the accordion id by turn", () => {
    expect(changedFilesAccordionId(turnId)).toBe(`changed-files:${turnId}`);
  });

  it("estimates only the header row while collapsed", () => {
    const withoutFiles = estimate({ withFiles: false });
    // `mt-2` plus the collapsed section header.
    expect(estimate({ withFiles: true }) - withoutFiles).toBe(44);
  });

  it("adds the panel and root tree rows once opened", () => {
    const collapsed = estimate({ withFiles: true });
    const open = estimate({
      withFiles: true,
      openById: { [changedFilesAccordionId(turnId)]: true },
    });
    // Panel padding plus the two root directories.
    expect(open - collapsed).toBe(20 + 2 * 25);
  });
});
