import { expect, it } from "vitest";
import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";

import {
  singleChoiceQuestionAsksForMultiple,
  visibleUserInputOptionDescription,
} from "./option.logic";

const layers = (overrides: Partial<UserInputQuestion> = {}): UserInputQuestion => ({
  id: "layers",
  header: "Which layers should the demo include? Select all that apply.",
  question: "Which layers should the demo include? Select all that apply.",
  options: [
    { id: "Roads", label: "Roads", description: "Roads" },
    { id: "Buildings", label: "Buildings", description: "Buildings" },
  ],
  multiSelect: false,
  ...overrides,
});

it("hides a description that only repeats its label", () => {
  expect(visibleUserInputOptionDescription({ label: "Roads", description: "Roads" })).toBeNull();
  expect(
    visibleUserInputOptionDescription({ label: "Wind farms", description: " wind  FARMS " }),
  ).toBeNull();
  expect(visibleUserInputOptionDescription({ label: "Allow", description: "" })).toBeNull();
});

it("keeps a description that adds information", () => {
  expect(visibleUserInputOptionDescription({ label: "Staging", description: "Safe first" })).toBe(
    "Safe first",
  );
});

it("flags multi-select wording on a single-choice question", () => {
  expect(singleChoiceQuestionAsksForMultiple(layers())).toBe(true);
  expect(
    singleChoiceQuestionAsksForMultiple(
      layers({ header: "Layers", question: "Pick one or more layers." }),
    ),
  ).toBe(true);
});

it("leaves real multi-select and ordinary single-choice questions alone", () => {
  expect(singleChoiceQuestionAsksForMultiple(layers({ multiSelect: true }))).toBe(false);
  expect(
    singleChoiceQuestionAsksForMultiple(
      layers({ header: "Map style", question: "Which map style should the demo use?" }),
    ),
  ).toBe(false);
  expect(singleChoiceQuestionAsksForMultiple(layers({ options: [] }))).toBe(false);
});
