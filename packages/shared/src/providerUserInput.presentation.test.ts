import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";
import { describe, expect, it } from "vitest";

import {
  pendingUserInputAcceptsContext,
  singleChoiceQuestionAsksForMultiple,
} from "./providerUserInput";

const question: UserInputQuestion = {
  id: "branch",
  header: "Branch",
  question: "Choose all that apply.",
  options: [
    { label: "main", description: "Current branch" },
    { label: "feature", description: "Feature branch" },
  ],
  multiSelect: false,
};

describe("provider user-input presentation guards", () => {
  it("preserves context for legacy label answers and custom-allowed string fields", () => {
    expect(pendingUserInputAcceptsContext(question)).toBe(true);
    expect(
      pendingUserInputAcceptsContext({
        ...question,
        field: { type: "string", required: true, allowCustom: true },
      }),
    ).toBe(true);
  });

  it("does not promise free text for stable option IDs, even in a custom string field", () => {
    expect(
      pendingUserInputAcceptsContext({
        ...question,
        options: [{ ...question.options[0]!, id: "stable-main" }],
        field: { type: "string", required: true, allowCustom: true },
      }),
    ).toBe(false);
  });

  it.each([
    { type: "string", required: true, allowCustom: false },
    { type: "boolean", required: true, allowCustom: false },
    { type: "number", required: true, allowCustom: false },
    { type: "integer", required: true, allowCustom: false },
    { type: "multiselect", required: true, allowCustom: true },
  ] satisfies NonNullable<UserInputQuestion["field"]>[])(
    "does not promise an appended context string for %s",
    (field) => {
      expect(pendingUserInputAcceptsContext({ ...question, field })).toBe(false);
    },
  );

  it("warns about multiple-pick wording only when the actual question is single choice", () => {
    expect(singleChoiceQuestionAsksForMultiple(question)).toBe(true);
    expect(singleChoiceQuestionAsksForMultiple({ ...question, multiSelect: true })).toBe(false);
    expect(
      singleChoiceQuestionAsksForMultiple({
        ...question,
        field: { type: "multiselect", required: true, allowCustom: false },
      }),
    ).toBe(false);
    expect(
      singleChoiceQuestionAsksForMultiple({ ...question, options: [question.options[0]!] }),
    ).toBe(false);
    expect(singleChoiceQuestionAsksForMultiple({ ...question, question: "Which branch?" })).toBe(
      false,
    );
  });
});
