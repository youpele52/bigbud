import { ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { matchThreadCoordinationProof } from "./ThreadCoordinationConfirmation.logic.ts";
import { threadCoordinationQuestion } from "./ThreadCoordinationConfirmation.result.ts";
import { questionEvent, responseEvent } from "./ThreadCoordinationConfirmation.test.helpers.ts";

/**
 * Answers as bigbud's docked question panel sends them for each provider's question tool:
 * Codex `request_user_input`, Pi `ask_user`, Devin `ask_user_question`, Claude `AskUserQuestion`.
 */
const caller = ThreadId.makeUnsafe("caller-panel");
const challenge = { code: "BB-7Q4KM2XZ", projectTitle: "Billing", streamSequenceFloor: 10 };
const question = threadCoordinationQuestion({ ...challenge, targetIsRemote: false });

type Choices = ReadonlyArray<{ label: string; id?: string }>;

/** Option ids equal to labels, as the Pi adapter and Devin's `const` values produce them. */
const idChoices: Choices = [
  { label: "Allow", id: "Allow" },
  { label: "Deny", id: "Deny" },
];

const answer = (value: unknown, options: { questionId?: string; choices?: Choices } = {}) => {
  const questionId = options.questionId ?? question;
  const events: ReadonlyArray<OrchestrationEvent> = [
    questionEvent({
      threadId: caller,
      sequence: 11,
      requestId: "request-1",
      question,
      questionId,
      ...(options.choices ? { options: options.choices } : {}),
    }),
    responseEvent({
      threadId: caller,
      sequence: 12,
      requestId: "request-1",
      answers: { [questionId]: value },
    }),
  ];
  return matchThreadCoordinationProof({ callerThreadId: caller, challenge, question, events });
};

describe("question panel answers", () => {
  it.each([
    ["Codex agent-chosen question id", "Allow", { questionId: "confirm_project" }],
    [
      "Pi fallback question id with id options",
      "Allow",
      { questionId: "answer", choices: idChoices },
    ],
    ["Devin form field with const options", "Allow", { questionId: "q0", choices: idChoices }],
    ["Devin single-entry multi-select", ["Allow"], { questionId: "q0", choices: idChoices }],
  ])("accepts %s", (_name, value, options) => {
    expect(answer(value, options)).toBe("allowed");
  });

  it("treats an Allow chip with typed context as Allow unless the context refuses", () => {
    expect(answer("Allow\nThanks, go ahead with the message")).toBe("allowed");
    expect(answer("Allow\nOnly for this one task, but fine")).toBe("allowed");
    expect(answer("Allow\nActually no, don't touch that project")).toBe("denied");
    expect(answer("Deny\nyes I'm sure")).toBe("denied");
  });

  it("judges text typed into the panel without a chip like a chat reply", () => {
    expect(answer("yes")).toBe("allowed");
    expect(answer("go ahead")).toBe("allowed");
    expect(answer("no thanks")).toBe("denied");
    expect(answer("wait, which thread is that?")).toBe("none");
    expect(answer("hmm")).toBe("none");
  });

  it("does not let typed text that quotes the question back decide", () => {
    expect(answer(question)).toBe("none");
  });

  it("still lets a Deny anywhere in a multi-value answer win", () => {
    expect(answer(["Allow", "Deny"], { questionId: "q0", choices: idChoices })).toBe("denied");
    expect(answer("Allow, Deny")).toBe("denied");
  });

  it("still requires an Allow option, even when typed text approves", () => {
    const yesNo: Choices = [{ label: "Yes" }, { label: "No" }];
    expect(answer("yes", { choices: yesNo })).toBe("none");
    expect(answer("Yes", { choices: yesNo })).toBe("none");
  });
});
