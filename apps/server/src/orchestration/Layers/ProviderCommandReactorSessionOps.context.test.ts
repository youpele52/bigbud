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
        provider: "codex",
        thread: { messages: [message("user", "first"), message("assistant", "answer")] },
        bootstrapThread: null,
        activeSession: undefined,
        messageText: "next",
        attachments: [],
      } as never),
    ).toBe(true);
  });

  it("rebuilds context for a message with attachments (attachments are forwarded separately)", () => {
    const image = { type: "image", id: "img-1", name: "shot.png", mimeType: "image/png" };
    expect(
      shouldRebuildProviderContextFromTranscript({
        provider: "codex",
        thread: { messages: [message("user", "first"), message("assistant", "answer")] },
        bootstrapThread: null,
        activeSession: undefined,
        messageText: "what is in this image?",
        attachments: [image],
      } as never),
    ).toBe(true);
    expect(
      shouldRebuildProviderContextFromTranscript({
        provider: "codex",
        thread: { messages: [] },
        bootstrapThread: { messages: [message("user", "source"), message("assistant", "reply")] },
        activeSession: undefined,
        messageText: "continue with this file",
        attachments: [image],
      } as never),
    ).toBe(true);
  });

  it("never replays an inactive OpenCode V2 thread onto its retained native history", () => {
    // Every thread reaches send with its session projected "starting" by turn-start-requested.
    const session = { status: "starting", providerName: "opencodeV2" };
    const forkOrigin = { forkPointMessageId: "m-2", reason: "manual", failureEventId: null };
    const copied = [
      { ...message("user", "first"), turnId: null },
      { ...message("assistant", "answer"), turnId: null },
    ];
    const replied = [
      { ...message("user", "first"), turnId: "t-1" },
      { ...message("assistant", "answer"), turnId: "t-1" },
    ];
    const history = { session, messages: replied };
    expect(
      shouldRebuildProviderContextFromTranscript({
        provider: "opencodeV2",
        thread: history,
        bootstrapThread: null,
        activeSession: undefined,
        messageText: "next",
        attachments: [],
      } as never),
    ).toBe(false);
    expect(
      shouldRebuildProviderContextFromTranscript({
        provider: "opencodeV2",
        thread: { session, messages: copied },
        bootstrapThread: null,
        activeSession: undefined,
        messageText: "next",
        attachments: [],
      } as never),
    ).toBe(false);
    // Once a fork has replied on its own, its native session holds the replayed transcript.
    expect(
      shouldRebuildProviderContextFromTranscript({
        provider: "opencodeV2",
        thread: { session, forkOrigin, messages: [...copied, ...history.messages] },
        bootstrapThread: null,
        activeSession: undefined,
        messageText: "next",
        attachments: [],
      } as never),
    ).toBe(false);
    // A fork copies the transcript with no turn ids onto a new, empty native session, so the
    // copied transcript must seed it.
    expect(
      shouldRebuildProviderContextFromTranscript({
        provider: "opencodeV2",
        thread: { session, forkOrigin, messages: copied },
        bootstrapThread: null,
        activeSession: undefined,
        messageText: "next",
        attachments: [],
      } as never),
    ).toBe(true);
    // A branched thread gets its own native session, so its source transcript still seeds it.
    expect(
      shouldRebuildProviderContextFromTranscript({
        provider: "opencodeV2",
        thread: { messages: [] },
        bootstrapThread: history,
        activeSession: undefined,
        messageText: "continue",
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
