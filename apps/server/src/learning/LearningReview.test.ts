import { MessageId, TurnId, type OrchestrationMessage } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { buildLearningReviewTranscript } from "./LearningReview.ts";

function message(input: {
  readonly id: string;
  readonly turnId: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming?: boolean;
}): OrchestrationMessage {
  return {
    id: MessageId.makeUnsafe(input.id),
    turnId: TurnId.makeUnsafe(input.turnId),
    role: input.role,
    text: input.text,
    streaming: input.streaming ?? false,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

describe("buildLearningReviewTranscript", () => {
  it("includes finalized user and assistant messages through the reviewed turn", () => {
    const transcript = buildLearningReviewTranscript(
      {
        messages: [
          message({ id: "message-1", turnId: "turn-1", role: "user", text: "first user" }),
          message({
            id: "message-2",
            turnId: "turn-1",
            role: "assistant",
            text: "first assistant",
          }),
          message({ id: "message-3", turnId: "turn-2", role: "user", text: "second user" }),
          message({
            id: "message-4",
            turnId: "turn-2",
            role: "assistant",
            text: "second assistant",
          }),
          message({
            id: "message-5",
            turnId: "turn-2",
            role: "system",
            text: "system noise",
          }),
          message({
            id: "message-6",
            turnId: "turn-2",
            role: "assistant",
            text: "streaming noise",
            streaming: true,
          }),
          message({ id: "message-7", turnId: "turn-3", role: "user", text: "later user" }),
        ],
      },
      "turn-2",
      "second user",
      true,
    );

    expect(transcript).toBe(
      "USER:\nfirst user\n\nASSISTANT:\nfirst assistant\n\nUSER:\nsecond user\n\nASSISTANT:\nsecond assistant",
    );
  });

  it("retains the current-turn transcript for skill-only reviews", () => {
    const transcript = buildLearningReviewTranscript(
      {
        messages: [
          message({ id: "message-1", turnId: "turn-1", role: "user", text: "first user" }),
          message({
            id: "message-2",
            turnId: "turn-1",
            role: "assistant",
            text: "first assistant",
          }),
        ],
      },
      "turn-1",
      "first user",
      false,
    );

    expect(transcript).toBe("USER:\nfirst user\n\nASSISTANT:\nfirst assistant");
  });
});
