import { describe, expect, it } from "vitest";

import { museRecordedUserInputAnswers } from "./Adapter.questions.settlement.ts";
import { makeMuseHostCallbacks } from "./Adapter.startSession.callbacks.ts";
import { makeMuseTestState, threadId } from "./Adapter.failures.test.helpers.ts";

describe("Muse recorded settlement answer decoding", () => {
  it.each(["cancelled", "timedOut", "aborted", "clarified"])(
    "preserves empty %s cancellation/closure semantics",
    (outcome) => {
      expect(
        museRecordedUserInputAnswers({
          sessionId: "native",
          userInputId: "prompt",
          outcome,
          answers: [],
        }),
      ).toEqual({});
    },
  );
  it("preserves confirmed partial interrupted answers and notes losslessly", () => {
    const answer = { questionId: "q", selectedLabel: "choice", note: "also keep this comment" };
    expect(
      museRecordedUserInputAnswers({
        sessionId: "native",
        userInputId: "prompt",
        outcome: "interrupted",
        answers: [answer],
      }),
    ).toEqual({ q: answer });
  });
  it.each([
    { answers: undefined },
    { answers: [] },
    { answers: [null] },
    { answers: [{ questionId: "q", selectedLabel: 42 }] },
    { answers: [{ questionId: "q", selectedLabel: "one", freeText: "two" }] },
    {
      answers: [
        { questionId: "q", freeText: "one" },
        { questionId: "q", freeText: "two" },
      ],
    },
    { answers: [{ questionId: "q", selectedLabels: [null] }] },
  ])(
    "retains pending input and emits a diagnostic for malformed recorded answers: %j",
    async ({ answers }) => {
      const state = makeMuseTestState();
      const events: Array<string> = [];
      state.pendingUserInputs.set("prompt", {
        requestId: "prompt",
        sessionId: "native",
        params: {},
      });
      const callbacks = makeMuseHostCallbacks({
        threadId,
        admissions: undefined,
        getState: () => state,
        emit: (event) => events.push(event.type),
      });
      await callbacks.activate();
      callbacks.onNotification({
        method: "userInput/settled",
        params: { sessionId: "native", userInputId: "prompt", outcome: "answered", answers },
      });
      expect(state.pendingUserInputs.has("prompt")).toBe(true);
      expect(events).toEqual(["runtime.error"]);
    },
  );
});
