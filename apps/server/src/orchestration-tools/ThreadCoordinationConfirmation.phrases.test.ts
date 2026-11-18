import { describe, expect, it } from "vitest";

import {
  THREAD_COORDINATION_ALLOW_PHRASES,
  THREAD_COORDINATION_DENY_PHRASES,
  THREAD_COORDINATION_HEDGE_PHRASES,
  classifyConfirmationReply,
} from "./ThreadCoordinationConfirmation.phrases.ts";
import { threadCoordinationQuestion } from "./ThreadCoordinationConfirmation.result.ts";

const question = threadCoordinationQuestion({
  code: "BB-NOTE2345",
  projectTitle: "Stop Never",
  targetIsRemote: false,
});

describe("classifyConfirmationReply", () => {
  it.each([
    "I approve. Please send Say hi to the attached thread.",
    "allow",
    "allow  BB-XXXXXXXX",
    "allow BB-NOTE2345",
    "yes",
    "Yes!",
    "yes please",
    "ok send it now",
    "  y",
    "yep, go",
    "Okay",
    "ok.",
    "Sure thing",
    "go ahead",
    "Do it",
    "proceed",
    "Confirmed",
    "approved",
    "**Allow**",
    "yes, I know",
    "ok, note that",
    "yes, and another one",
    "yes, notify them",
  ])("allows %j", (text) => {
    expect(classifyConfirmationReply(text, { question })).toBe("allowed");
  });

  it.each([
    "no thanks",
    "No",
    "nope",
    "deny BB-XXXXXXXX",
    "Don’t do that",
    "do not",
    "dont",
    "stop",
    "cancel it",
    "not allowed",
    "never",
    "I don't approve",
    "yes but don't send it",
    "sure thing, actually no",
    "Okay no",
    "yes, I mean no",
    "yes\nactually no",
    `${question} no`,
    `"${question}" — no`,
    "no, go ahead",
    "not now",
    "stop, yes",
    "'no'",
    "Allow? no",
  ])("denies %j", (text) => {
    expect(classifyConfirmationReply(text, { question })).toBe("denied");
  });

  it.each([
    "ok wait",
    "Do it later",
    "approve the PR first",
    "yes, hold on",
    "sure, but send it tomorrow",
    "maybe",
    "use the other one instead",
    "y?",
    "yes?",
    "thanks",
    "what does it do?",
    "What does BB-XXXXXXXX let you do?",
    "yesterday was fine",
    "nothing yet",
    "okayish",
    question,
    `yes: ${question}`,
    "yes, allow this thread to do that",
    "",
    "   ",
  ])("is not decisive for %j", (text) => {
    expect(classifyConfirmationReply(text, { question })).toBe("none");
  });

  it("never reads the quoted project title or code as the user's refusal", () => {
    // "Stop Never" and "BB-NOTE2345" are in the question, not the user's own words.
    expect(classifyConfirmationReply(`${question} thanks`, { question })).toBe("none");
    expect(classifyConfirmationReply("allow BB-NOTE2345")).toBe("allowed");
  });

  it("covers every phrase in the decision", () => {
    expect([...THREAD_COORDINATION_ALLOW_PHRASES].toSorted()).toEqual(
      [
        "allow",
        "yes",
        "yep",
        "yeah",
        "y",
        "approve",
        "approved",
        "i approve",
        "ok",
        "okay",
        "sure",
        "go ahead",
        "do it",
        "proceed",
        "confirm",
        "confirmed",
      ].toSorted(),
    );
    expect([...THREAD_COORDINATION_DENY_PHRASES].toSorted()).toEqual(
      [
        "no",
        "nope",
        "not",
        "don't",
        "dont",
        "do not",
        "stop",
        "cancel",
        "deny",
        "never",
      ].toSorted(),
    );
    expect([...THREAD_COORDINATION_HEDGE_PHRASES].toSorted()).toEqual(
      ["wait", "hold", "later", "first", "but", "actually", "instead", "maybe"].toSorted(),
    );
  });
});
