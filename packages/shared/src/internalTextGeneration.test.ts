import { describe, expect, it } from "vitest";
import {
  successfulUserTurns,
  USER_TURN_BOUND,
  MODEL_SUCCEEDED,
  supportsInternalTextGeneration,
  FULL_TEXT_GENERATION_PROVIDERS,
} from "./internalTextGeneration";

it("supports CLIProxy titles through Claude without advertising unsupported global generation overrides", () => {
  expect(supportsInternalTextGeneration("cliProxy", "generateThreadTitle")).toBe(true);
  expect(supportsInternalTextGeneration("cliProxy", "generateCommitMessage")).toBe(false);
  expect(supportsInternalTextGeneration("cliProxy", "generateThreadElevatorSummary")).toBe(false);
  expect(FULL_TEXT_GENERATION_PROVIDERS).not.toContain("cliProxy");
});

describe("verified successful user turns", () => {
  const binding = (turnId: string, messageId: string) => ({
    kind: USER_TURN_BOUND,
    turnId,
    payload: { messageId },
  });
  const success = (turnId: string) => ({
    kind: MODEL_SUCCEEDED,
    turnId,
    payload: { provider: "codex", model: "actual-model" },
  });
  it("deduplicates user submissions and success events, not just provider turn IDs", () => {
    expect(
      successfulUserTurns([
        binding("a", "user1"),
        success("a"),
        success("a"),
        binding("retry-a", "user1"),
        success("retry-a"),
        binding("b", "user2"),
        success("b"),
      ]),
    ).toHaveLength(2);
  });
  it("ignores failed, cancelled, internal, tool-only, and unverified events", () => {
    expect(
      successfulUserTurns([
        binding("failed", "user1"),
        { ...success("failed"), kind: "turn.failed" },
        { ...success("failed"), kind: "turn.cancelled" },
        success("internal"),
        { ...success("internal"), turnId: null },
      ]),
    ).toEqual([]);
  });
  it("survives ordering where success was persisted before the send acknowledgement binding", () => {
    expect(successfulUserTurns([success("a"), binding("a", "user1")])).toMatchObject([
      { messageId: "user1", turnId: "a", model: { provider: "codex", model: "actual-model" } },
    ]);
  });
});
