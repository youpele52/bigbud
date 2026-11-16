import { describe, expect, it } from "vitest";

import {
  describePendingUserInputQuestion,
  pendingUserInputComposerHint,
} from "./pendingUserInputPresentation";

describe("pending question public presentation", () => {
  it("keeps question titles identical to the existing desktop pending/history language", () => {
    expect(
      describePendingUserInputQuestion({
        header: "Branch",
        question: "Which branch?",
        questionCount: 2,
        questionIndex: 1,
      }),
    ).toEqual({ title: "2. Branch", detail: "Which branch?", counterLabel: "2 of 2" });
  });

  it.each(["", "Which branch?"])("avoids duplicate detail for header %s", (header) => {
    expect(
      describePendingUserInputQuestion({
        header,
        question: "Which branch?",
        questionCount: 1,
        questionIndex: 0,
      }),
    ).toEqual({ title: "Which branch?", detail: null, counterLabel: null });
  });

  it("never promises context alongside a choice when the provider cannot send it", () => {
    expect(
      pendingUserInputComposerHint({
        hasOptions: true,
        acceptsContext: false,
        singleChoiceAsksForMultiple: false,
      }),
    ).toBeNull();
    expect(
      pendingUserInputComposerHint({
        hasOptions: true,
        acceptsContext: false,
        singleChoiceAsksForMultiple: true,
      }),
    ).toBe("Only one option can be picked here.");
  });

  it("offers free text for questions with no options regardless of context flag", () => {
    for (const acceptsContext of [true, false]) {
      expect(
        pendingUserInputComposerHint({
          hasOptions: false,
          acceptsContext,
          singleChoiceAsksForMultiple: false,
        }),
      ).toBe("Type your answer in the message box and send.");
    }
  });
});
