import { expect, it } from "vitest";
import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";

import { derivePendingUserInputProgress } from "../../../../logic/user-input/pending.logic";
import {
  derivePendingComposerAction,
  derivePendingUserInputPanelModel,
  pendingUserInputComposerPlaceholder,
} from "./PendingUserInputPanel.logic";

const deploy: UserInputQuestion = {
  id: "deploy",
  header: "Deploy target",
  question: "Where should this deploy?",
  options: [
    { label: "Staging", description: "Safe first" },
    { label: "Production", description: "Live users" },
  ],
  multiSelect: false,
};
const areas: UserInputQuestion = {
  id: "areas",
  header: "Areas",
  question: "Areas",
  options: [{ label: "Server", description: "Backend" }],
  multiSelect: true,
};
const model = (questions: UserInputQuestion[], index: number, drafts = {}) =>
  derivePendingUserInputPanelModel({
    questions,
    progress: derivePendingUserInputProgress(questions, drafts, index),
  })!;

it("derives a counter, history-matching title and selection state for the active question", () => {
  const first = model([deploy, areas], 0, { deploy: { selectedOptionLabels: ["Production"] } });
  expect(first).toMatchObject({
    counterLabel: "1 of 2",
    title: "1. Deploy target",
    detail: "Where should this deploy?",
    multiple: false,
    canGoPrevious: false,
    canGoNext: true,
    hint: "Add context in the message box, or just send your selection.",
  });
  expect(first.options.map((option) => option.selected)).toEqual([false, true]);
  const second = model([deploy, areas], 1);
  expect(second).toMatchObject({
    counterLabel: "2 of 2",
    title: "2. Areas",
    detail: null,
    multiple: true,
    canGoPrevious: true,
    canGoNext: false,
  });
  expect(model([deploy], 0)).toMatchObject({ counterLabel: null, title: "Deploy target" });
});

it("hides the context hint where text cannot travel with a choice", () => {
  const strict = { ...deploy, field: { type: "string", required: true, allowCustom: false } };
  expect(model([strict as UserInputQuestion], 0).hint).toBeNull();
  const ids = { ...deploy, options: [{ id: "a", label: "A", description: "A" }] };
  expect(model([ids], 0).hint).toBeNull();
  expect(model([{ ...deploy, options: [] }], 0).hint).toBe(
    "Type your answer in the message box and send.",
  );
});

it("says only one pick is sent when a single-choice question asks for several", () => {
  const question = "Which layers? Select all that apply.";
  const pi = {
    ...deploy,
    question,
    options: [
      { id: "Roads", label: "Roads", description: "Roads" },
      { id: "Buildings", label: "Buildings", description: "Buildings" },
    ],
  };
  expect(model([pi], 0).hint).toBe("Only one option can be picked here.");
  expect(model([{ ...deploy, question }], 0).hint).toBe(
    "Only one option can be picked here. Name any others in the message box.",
  );
  expect(model([{ ...deploy, question, multiSelect: true }], 0).hint).not.toContain("Only one");
});

it("offers Next/Submit whenever a question is pending, regardless of provider mode", () => {
  expect(
    derivePendingComposerAction({ progress: null, isResponding: false, resolvedAnswers: null }),
  ).toBeNull();
  const progress = derivePendingUserInputProgress([deploy, areas], {}, 0);
  expect(
    derivePendingComposerAction({ progress, isResponding: true, resolvedAnswers: null }),
  ).toEqual({
    questionIndex: 0,
    isLastQuestion: false,
    canAdvance: false,
    isResponding: true,
    isComplete: false,
  });
  expect(
    derivePendingComposerAction({ progress, isResponding: false, resolvedAnswers: {} })?.isComplete,
  ).toBe(true);
});

it("only promises context where it is sent, and flags typed text a choice will drop", () => {
  const ids = { ...deploy, options: [{ id: "a", label: "A", description: "A" }] };
  expect(pendingUserInputComposerPlaceholder(deploy)).toBe(
    "Add context, or just send your selection",
  );
  expect(pendingUserInputComposerPlaceholder(ids)).toBe(
    "Pick an option, or type an answer instead",
  );
  expect(
    model([ids], 0, { deploy: { selectedOptionIds: ["a"], customAnswer: "x" } }).textIgnored,
  ).toBe(true);
  expect(model([ids], 0, { deploy: { customAnswer: "x" } }).textIgnored).toBe(false);
  const jsonEntries = {
    ...deploy,
    multiSelect: true,
    field: { type: "multiselect", required: true, allowCustom: true },
  } as UserInputQuestion;
  expect(
    model([jsonEntries], 0, {
      deploy: { selectedOptionLabels: ["Staging"], customAnswer: '["x"]' },
    }).textIgnored,
  ).toBe(false);
  expect(
    model([deploy], 0, { deploy: { selectedOptionLabels: ["Staging"], customAnswer: "x" } })
      .textIgnored,
  ).toBe(false);
});
