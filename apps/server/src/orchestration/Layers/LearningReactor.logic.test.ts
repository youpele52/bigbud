import { MessageId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  countFinalizedUserMessages,
  resolveLearningModelSelection,
  shouldScheduleMemoryReview,
} from "./LearningReactor.logic.ts";

function message(input: {
  readonly role: "user" | "assistant" | "system";
  readonly streaming?: boolean;
}) {
  return {
    id: MessageId.makeUnsafe(crypto.randomUUID()),
    role: input.role,
    text: input.role,
    turnId: null,
    streaming: input.streaming ?? false,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

describe("LearningReactor scheduling", () => {
  it("counts finalized user messages only", () => {
    expect(
      countFinalizedUserMessages([
        message({ role: "user" }),
        message({ role: "assistant" }),
        message({ role: "system" }),
        message({ role: "user", streaming: true }),
      ]),
    ).toBe(1);
  });

  it("schedules the first review at fifteen user messages", () => {
    expect(
      shouldScheduleMemoryReview({ userMessageCount: 14, latestMemoryUserMessageCount: null }),
    ).toBe(false);
    expect(
      shouldScheduleMemoryReview({ userMessageCount: 15, latestMemoryUserMessageCount: null }),
    ).toBe(true);
  });

  it("schedules each subsequent review after fifteen more user messages", () => {
    expect(
      shouldScheduleMemoryReview({ userMessageCount: 29, latestMemoryUserMessageCount: 15 }),
    ).toBe(false);
    expect(
      shouldScheduleMemoryReview({ userMessageCount: 30, latestMemoryUserMessageCount: 15 }),
    ).toBe(true);
    expect(
      shouldScheduleMemoryReview({ userMessageCount: 31, latestMemoryUserMessageCount: 15 }),
    ).toBe(true);
  });

  it("preserves provider identity when resolving learning selections", () => {
    expect(
      resolveLearningModelSelection({
        provider: "cliProxy",
        model: "gpt-5-codex",
        selected: { provider: "cliProxy", model: "old-model" },
      }),
    ).toEqual({ provider: "cliProxy", model: "gpt-5-codex" });
    expect(
      resolveLearningModelSelection({
        provider: "claudeAgent",
        model: "sonnet",
        selected: { provider: "cliProxy", model: "gpt-5-codex" },
      }),
    ).toEqual({ provider: "claudeAgent", model: "sonnet" });
  });
});
