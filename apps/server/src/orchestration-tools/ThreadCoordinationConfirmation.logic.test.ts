import { ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { matchThreadCoordinationProof } from "./ThreadCoordinationConfirmation.logic.ts";
import { threadCoordinationQuestion } from "./ThreadCoordinationConfirmation.result.ts";
import {
  messageEvent,
  queuedPromptEvent,
  questionEvent,
  resolvedActivityEvent,
  responseEvent,
  segment,
} from "./ThreadCoordinationConfirmation.test.helpers.ts";

const caller = ThreadId.makeUnsafe("caller-a1");
const other = ThreadId.makeUnsafe("other-a2");
const challenge = { code: "BB-7Q4KM2XZ", projectTitle: "Billing", streamSequenceFloor: 10 };
const question = threadCoordinationQuestion({ ...challenge, targetIsRemote: true });

const match = (events: ReadonlyArray<OrchestrationEvent>) =>
  matchThreadCoordinationProof({ callerThreadId: caller, challenge, events });

type AnswerOptions = {
  questionId?: string;
  text?: string;
  choices?: ReadonlyArray<{ label: string; id?: string }>;
  questionThread?: ThreadId;
  commandId?: string;
};

/** A question at sequence 11 and its client answer at 12. */
const answered = (answers: Record<string, unknown>, options: AnswerOptions = {}) => [
  questionEvent({
    threadId: options.questionThread ?? caller,
    sequence: 11,
    requestId: "request-1",
    question: options.text ?? question,
    ...(options.questionId ? { questionId: options.questionId } : {}),
    ...(options.choices ? { options: options.choices } : {}),
  }),
  responseEvent({
    threadId: caller,
    sequence: 12,
    requestId: "request-1",
    answers,
    ...(options.commandId ? { commandId: options.commandId } : {}),
  }),
];

describe("question proof", () => {
  it.each([
    ["Claude question-text key", { [question]: "Allow" }, {}],
    ["Copilot answer key", { answer: "Allow" }, { questionId: "answer" }],
    [
      "Muse option id",
      { q1: "opt-allow" },
      {
        questionId: "q1",
        choices: [
          { label: "Allow", id: "opt-allow" },
          { label: "Deny", id: "opt-deny" },
        ],
      },
    ],
    ["multi-select array", { answer: ["Allow"] }, { questionId: "answer" }],
  ])("accepts %s", (_name, answers, options) => {
    expect(match(answered(answers, options))).toBe("allowed");
  });

  it("returns denied for a Deny answer, including Deny beside Allow", () => {
    expect(match(answered({ [question]: "Deny" }))).toBe("denied");
    expect(match(answered({ answer: ["Allow", "Deny"] }, { questionId: "answer" }))).toBe("denied");
  });

  it.each<[string, AnswerOptions]>([
    ["a wrong code", { text: question.replace(challenge.code, "BB-AAAAAAAA") }],
    ["a question on a different thread", { questionThread: other }],
    ["a question without an Allow option", { choices: [{ label: "Yes" }, { label: "No" }] }],
    ["a server-dispatched response", { commandId: "server:respond" }],
    ["a provider-dispatched response", { commandId: "provider:respond" }],
  ])("rejects %s", (_name, options) => {
    const answers = { [options.text ?? question]: options.choices ? "Yes" : "Allow" };
    expect(match(answered(answers, options))).toBe("none");
  });

  it("no longer needs the project title, only the code and an Allow option", () => {
    const text = `Allow this? (Reference: ${challenge.code})`;
    expect(match(answered({ [text]: "Allow" }, { text }))).toBe("allowed");
  });

  it("rejects an answer to a question asked after it", () => {
    const [ask, reply] = answered({ [question]: "Allow" });
    expect(match([{ ...ask!, sequence: 13 }, reply!])).toBe("none");
  });

  it("never accepts a provider-reported user-input.resolved activity", () => {
    expect(
      match([
        questionEvent({ threadId: caller, sequence: 11, requestId: "pi-1", question }),
        resolvedActivityEvent({
          threadId: caller,
          sequence: 12,
          requestId: "pi-1",
          answers: { [question]: "Allow" },
        }),
      ]),
    ).toBe("none");
  });

  it("ignores events at or below the challenge floor", () => {
    const [ask, reply] = answered({ [question]: "Allow" });
    expect(
      match([
        { ...ask!, sequence: 9 },
        { ...reply!, sequence: 10 },
      ]),
    ).toBe("none");
  });
});

describe("chat proof", () => {
  const code = challenge.code;
  const said = (text: string, sequence = 11, overrides = {}) =>
    messageEvent({ threadId: caller, sequence, text, ...overrides });

  it("accepts a plain yes reply, with or without the code, as a message or queued prompt", () => {
    for (const text of [
      "allow",
      "yes",
      "I approve. Please send Say hi to the attached thread.",
      `allow  ${code}`,
    ]) {
      expect(match([said(text)])).toBe("allowed");
    }
    expect(
      match([said("ok", 11, { originSegments: [segment("ordinaryUser", "user", "ok")] })]),
    ).toBe("allowed");
    expect(match([queuedPromptEvent({ threadId: caller, sequence: 11, text: "go ahead" })])).toBe(
      "allowed",
    );
  });

  it("returns denied for a refusal and nothing for a question or an unrelated reply", () => {
    expect(match([said("no thanks")])).toBe("denied");
    expect(match([said(`deny ${code}`)])).toBe("denied");
    expect(match([said(`What does ${code} let you do?`)])).toBe("none");
    expect(match([said("thanks")])).toBe("none");
  });

  it("lets the latest trusted user message decide an Allow", () => {
    expect(match([said("yes", 11), said("no", 12)])).toBe("denied");
    expect(match([said("yes", 11), said("what next?", 12)])).toBe("none");
    // An untrusted later message does not displace the latest trusted one.
    expect(match([said("yes", 11), said("no", 12, { role: "assistant" })])).toBe("allowed");
  });

  it("keeps a chat refusal standing over a later yes or chatter", () => {
    expect(match([said("no", 11), said("yes", 12)])).toBe("denied");
    expect(match([said("no", 11), said("thanks", 12)])).toBe("denied");
    expect(match([said("not now", 11), said("go ahead", 12)])).toBe("denied");
  });

  it("does not let a quoted question or its project title decide", () => {
    expect(match([said(question)])).toBe("none");
    expect(match([said(`${question} no`)])).toBe("denied");
  });

  it("lets any decisive Deny win over an Allow within one challenge", () => {
    expect(match([...answered({ [question]: "Allow" }), said("no", 13)])).toBe("denied");
    expect(match([...answered({ [question]: "Deny" }), said("yes", 13)])).toBe("denied");
    expect(match([...answered({ [question]: "Allow" }), said("thanks", 13)])).toBe("allowed");
  });

  it.each([
    ["an assistant message", { role: "assistant" as const }],
    [
      "a crossThreadAgent message",
      { originSegments: [segment("crossThreadAgent", "agent", "yes")] },
    ],
    [
      "a completionWatch message",
      { originSegments: [segment("completionWatch", "automation", "yes")] },
    ],
    ["a server-prefixed command", { commandId: "server:provider-turn-start-queued:evt" }],
    ["a provider-prefixed command", { commandId: "provider:inject" }],
    ["a queue-flush command", { commandId: "queue-flush:v2:1" }],
    ["a message without a command", { commandId: null }],
    ["a message on another thread", { threadId: other }],
  ])("rejects %s", (_name, overrides) => {
    expect(match([said("yes", 11, overrides)])).toBe("none");
  });

  it("rejects an alreadySent re-queue and a yes only in the agent segment of a merged prompt", () => {
    expect(
      match([
        queuedPromptEvent({ threadId: caller, sequence: 11, text: "yes", alreadySent: true }),
      ]),
    ).toBe("none");
    expect(
      match([
        said("Additional instructions:\n- yes\n- thanks", 11, {
          originSegments: [
            segment("crossThreadAgent", "agent", "yes"),
            segment("ordinaryUser", "user", "thanks"),
          ],
        }),
      ]),
    ).toBe("none");
  });
});

describe("chat reply attribution", () => {
  const older = { code: "BB-BBBBBBBB", streamSequenceFloor: 10, issueOrder: 1 };
  const newer = { code: "BB-CCCCCCCC", streamSequenceFloor: 12, issueOrder: 2 };
  const said = (text: string, sequence: number) =>
    messageEvent({ threadId: caller, sequence, text });
  const verdictFor = (
    target: typeof older,
    events: ReadonlyArray<OrchestrationEvent>,
    issued: ReadonlyArray<typeof older & { resolvedAtSequence?: number }> = [older, newer],
  ) =>
    matchThreadCoordinationProof({
      callerThreadId: caller,
      challenge: target,
      issuedChallenges: issued,
      events,
    });

  it("gives a reply without a code only to the latest challenge pending when it was typed", () => {
    expect(verdictFor(newer, [said("yes", 13)])).toBe("allowed");
    expect(verdictFor(older, [said("yes", 13)])).toBe("none");
    // Before the newer challenge was issued, the older one was the latest.
    expect(verdictFor(older, [said("yes", 11)])).toBe("allowed");
  });

  it("gives a reply naming a code only to that challenge", () => {
    expect(verdictFor(older, [said(`yes ${older.code}`, 13)])).toBe("allowed");
    expect(verdictFor(newer, [said(`yes ${older.code}`, 13)])).toBe("none");
    expect(verdictFor(newer, [said("yes BB-ZZZZZZZZ", 13)])).toBe("none");
  });

  it("passes later replies to the next pending challenge once the latest is resolved", () => {
    const resolvedNewer = { ...newer, resolvedAtSequence: 14 };
    expect(verdictFor(older, [said("yes", 13), said("yes", 15)], [older, resolvedNewer])).toBe(
      "allowed",
    );
    expect(verdictFor(older, [said("yes", 13), said("yes", 14)], [older, resolvedNewer])).toBe(
      "none",
    );
  });

  it("keeps a refusal for the newer challenge from denying the older one", () => {
    expect(verdictFor(older, [said("no", 13)])).toBe("none");
    expect(verdictFor(newer, [said("no", 13)])).toBe("denied");
  });
});
