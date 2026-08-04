import { describe, expect, it } from "vitest";

import { buildResumedTurnInput } from "./ProviderCommandReactorHelpers.ts";
import { shouldRebuildProviderContextFromTranscript } from "./ProviderCommandReactorSessionOps.context.ts";

function message(role: "user" | "assistant", text: string, streaming = false) {
  return { role, text, streaming };
}

describe("provider transcript recovery", () => {
  it("rebuilds context when a session is gone and prior transcript exists", () => {
    expect(
      shouldRebuildProviderContextFromTranscript({
        thread: { messages: [message("user", "first"), message("assistant", "answer")] },
        bootstrapThread: null,
        activeSession: undefined,
        messageText: "next",
        attachments: [],
      } as never),
    ).toBe(true);
  });

  it("does not replay a trailing uncertain user or streaming assistant turn", () => {
    const input = buildResumedTurnInput({
      transcriptThread: {
        messages: [
          message("user", "completed question"),
          message("assistant", "completed answer"),
          message("user", "uncertain question"),
          message("assistant", "partial answer", true),
        ],
      } as never,
      latestTranscriptMessageText: "next question",
      latestProviderInputText: "next question",
    });

    expect(input).toContain("completed question");
    expect(input).toContain("completed answer");
    expect(input).toContain("Latest user request (answer this now):\nnext question");
    expect(input).not.toContain("uncertain question");
    expect(input).not.toContain("partial answer");
  });

  it("drops completed-looking items from a non-completed latest turn", () => {
    const input = buildResumedTurnInput({
      transcriptThread: {
        latestTurn: { turnId: "turn-uncertain", state: "error" },
        messages: [
          message("user", "completed question"),
          message("assistant", "completed answer"),
          { ...message("user", "failed question"), turnId: "turn-uncertain" },
          { ...message("assistant", "failed answer"), turnId: "turn-uncertain" },
        ],
      } as never,
      latestTranscriptMessageText: "next question",
      latestProviderInputText: "next question",
    });

    expect(input).toContain("completed answer");
    expect(input).not.toContain("failed question");
    expect(input).not.toContain("failed answer");
  });
});
