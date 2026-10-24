import { describe, expect, it } from "vitest";
import { makeActivity } from "./session.logic.test.helpers";
import {
  deriveAnsweredUserInputs,
  formatUserInputAnswer,
  formatUserInputHistoryForCopy,
} from "./session.userInputHistory.logic";
import { deriveTimelineEntries } from "./session.timeline.logic";
import { derivePendingUserInputs } from "./session.activity.logic";
import {
  deriveMessagesTimelineRows,
  estimateMessagesTimelineRowHeight,
} from "~/components/chat/messages/MessagesTimeline.logic";

const question = {
  id: "mode",
  header: "Mode",
  question: "Which mode should we use?",
  options: [
    { id: "safe", label: "Safe mode", description: "Read only" },
    { id: "write", label: "Write mode", description: "Allow changes" },
  ],
  multiSelect: true,
};
const requested = makeActivity({
  id: "requested",
  kind: "user-input.requested",
  sequence: 1,
  createdAt: "2026-10-24T10:00:00.000Z",
  payload: { requestId: "request-1", questions: [question] },
});
const resolved = makeActivity({
  id: "resolved",
  kind: "user-input.resolved",
  sequence: 2,
  createdAt: "2026-10-24T10:00:01.000Z",
  payload: { requestId: "request-1", answers: { mode: ["safe", "Custom entry"] } },
});

describe("answered user input history", () => {
  it("reconstructs persisted questions, all options, and answers after reload", () => {
    const activities = JSON.parse(JSON.stringify([resolved, requested]));
    expect(derivePendingUserInputs(activities)).toEqual([]);
    const history = deriveAnsweredUserInputs(activities);
    expect(history).toEqual([
      {
        requestId: "request-1",
        createdAt: requested.createdAt,
        questions: [question],
        answers: { mode: ["safe", "Custom entry"] },
        answeredAt: resolved.createdAt,
      },
    ]);
    const timeline = deriveTimelineEntries([], [], [], [], history);
    expect(timeline[0]).toMatchObject({
      kind: "user-input-question",
      createdAt: requested.createdAt,
      answers: history[0]!.answers,
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: timeline,
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnStartedAt: null,
    });
    expect(rows[0]).toMatchObject({ kind: "user-input-question", answers: history[0]!.answers });
    expect(estimateMessagesTimelineRowHeight(rows[0]!, { timelineWidthPx: 800 })).toBe(88);
  });

  it("keeps the same row identity and position when a pending question is answered", () => {
    const pending = deriveTimelineEntries([], [], [], derivePendingUserInputs([requested]));
    const history = deriveAnsweredUserInputs([requested, resolved]);
    const answered = deriveTimelineEntries(
      [],
      [],
      [],
      derivePendingUserInputs([requested]),
      history,
    );
    expect(answered).toHaveLength(1);
    expect(answered[0]?.id).toBe(pending[0]?.id);
    expect(answered[0]?.createdAt).toBe(pending[0]?.createdAt);
  });

  it("does not call cancellations, failures, or orphaned resolutions answered", () => {
    const cancelled = { ...resolved, payload: { requestId: "request-1", answers: {} } };
    const failed = makeActivity({
      id: "failed",
      kind: "provider.user-input.respond.failed",
      sequence: 3,
      payload: { requestId: "request-1" },
    });
    expect(deriveAnsweredUserInputs([requested, cancelled])).toEqual([]);
    expect(deriveAnsweredUserInputs([requested, resolved, failed])).toEqual([]);
    expect(deriveAnsweredUserInputs([resolved])).toEqual([]);
  });

  it("deduplicates redeliveries and preserves actual answers when a provider closes again", () => {
    const closed = { ...resolved, sequence: 3, payload: { requestId: "request-1", answers: {} } };
    expect(
      deriveAnsweredUserInputs([requested, resolved, requested, resolved, closed]),
    ).toHaveLength(1);
  });

  it.each([
    [["safe", "Custom entry"], "Safe mode, Custom entry"],
    ["write", "Write mode"],
    ["Free text\nsecond line", "Free text\nsecond line"],
    [false, "false"],
    [0, "0"],
    [undefined, "Skipped"],
    [[], "Skipped"],
  ])("formats %j without losing typed answers", (answer, expected) => {
    expect(formatUserInputAnswer(question, answer)).toBe(expected);
  });

  it("copies all questions, offered options, free text and typed answers", () => {
    const input = deriveAnsweredUserInputs([requested, resolved])[0]!;
    expect(
      formatUserInputHistoryForCopy(
        {
          ...input,
          questions: [
            question,
            {
              id: "notes",
              header: "Notes",
              question: "Any other context?",
              options: [],
            },
          ],
        },
        { mode: ["safe", "Custom entry"], notes: false },
      ),
    ).toBe(
      "Question 1: Which mode should we use?\nOptions:\n- Safe mode — Read only\n- Write mode — Allow changes\nYour answer: Safe mode, Custom entry\n\nQuestion 2: Any other context?\nYour answer: false",
    );
  });
});
