import { expect, it } from "vitest";
import type { UserInputQuestion } from "@bigbud/contracts";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  resolvePendingUserInputAnswer,
  togglePendingUserInputOptionSelection,
  setPendingUserInputCustomAnswer,
} from "./pending.logic";

const question: UserInputQuestion = {
  id: "choice",
  header: "Choice",
  question: "Choose",
  options: [
    { id: "one", label: "Same", description: "First" },
    { id: "two", label: "Same", description: "Second" },
  ],
  field: { type: "string", required: true, allowCustom: false },
};

it("explicit custom arrays combine with selected exact IDs without splitting commas or newlines", () => {
  const custom: UserInputQuestion = {
    ...question,
    multiSelect: true,
    field: { type: "multiselect", required: true, allowCustom: true, minItems: 2, maxItems: 4 },
  };
  let draft = setPendingUserInputCustomAnswer(undefined, '["a,b", "line\\nbreak"]', custom);
  expect(buildPendingUserInputAnswers([custom], { choice: draft })).toEqual({
    choice: ["a,b", "line\nbreak"],
  });
  draft = togglePendingUserInputOptionSelection(custom, draft, custom.options[1]!, 1);
  expect(buildPendingUserInputAnswers([custom], { choice: draft })).toEqual({
    choice: ["two", "a,b", "line\nbreak"],
  });
  draft = setPendingUserInputCustomAnswer(draft, '["other", "last"]', custom);
  expect(buildPendingUserInputAnswers([custom], { choice: draft })).toEqual({
    choice: ["two", "other", "last"],
  });
  const free: UserInputQuestion = { ...custom, options: [] };
  expect(buildPendingUserInputAnswers([free], { choice: { customAnswer: '["a", "b"]' } })).toEqual({
    choice: ["a", "b"],
  });
  for (const value of ["a,b", '["a"]', '["a", 2]', '["a", "b", "c", "d", "e"]', '["unterminated'])
    expect(buildPendingUserInputAnswers([free], { choice: { customAnswer: value } })).toBeNull();
});

it("typed closed choices submit exact IDs despite duplicate labels, and custom invalid text cannot enable send", () => {
  const draft = togglePendingUserInputOptionSelection(question, undefined, question.options[1]!, 1);
  expect(buildPendingUserInputAnswers([question], { choice: draft })).toEqual({ choice: "two" });
  expect(resolvePendingUserInputAnswer(question, { customAnswer: "Same" })).toBeNull();
  expect(
    derivePendingUserInputProgress([question], { choice: { customAnswer: "Same" } }, 0).canAdvance,
  ).toBe(false);
});

it("optional fields can be omitted but invalid populated fields block submit; strings preserve meaningful whitespace", () => {
  const optional: UserInputQuestion = {
    ...question,
    id: "note",
    options: [],
    field: { type: "string", required: false, allowCustom: true, maxLength: 5 },
  };
  expect(buildPendingUserInputAnswers([optional], {})).toEqual({});
  expect(derivePendingUserInputProgress([optional], {}, 0)).toMatchObject({
    canAdvance: true,
    isComplete: true,
  });
  expect(
    buildPendingUserInputAnswers([optional], { note: { customAnswer: "too long" } }),
  ).toBeNull();
  expect(buildPendingUserInputAnswers([optional], { note: { customAnswer: " a " } })).toEqual({
    note: " a ",
  });
});

it("required booleans/numbers/multiselects use the same constraints as server validation", () => {
  const boolean: UserInputQuestion = {
    ...question,
    id: "bool",
    options: [{ id: "false", label: "No", description: "No" }],
    field: { type: "boolean", required: true, allowCustom: false },
  };
  expect(
    buildPendingUserInputAnswers([boolean], { bool: { selectedOptionIds: ["false"] } }),
  ).toEqual({ bool: "false" });
  const numeric: UserInputQuestion = {
    ...question,
    id: "n",
    options: [],
    field: { type: "integer", required: true, allowCustom: true, minimum: 1, maximum: 3 },
  };
  expect(buildPendingUserInputAnswers([numeric], { n: { customAnswer: "4" } })).toBeNull();
  expect(buildPendingUserInputAnswers([numeric], { n: { customAnswer: "2" } })).toEqual({ n: "2" });
  const multi: UserInputQuestion = {
    ...question,
    multiSelect: true,
    field: { type: "multiselect", required: true, allowCustom: false, minItems: 2, maxItems: 2 },
  };
  expect(
    buildPendingUserInputAnswers([multi], { choice: { selectedOptionIds: ["one"] } }),
  ).toBeNull();
  expect(
    buildPendingUserInputAnswers([multi], { choice: { selectedOptionIds: ["one", "two"] } }),
  ).toEqual({ choice: ["one", "two"] });
});
