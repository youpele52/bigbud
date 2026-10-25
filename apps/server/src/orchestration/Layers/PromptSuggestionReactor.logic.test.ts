import { EventId, MessageId, type OrchestrationThread, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  buildPromptSuggestionTranscript,
  generatedSuggestionSkipReason,
  promptSuggestionCancelThreadId,
} from "./PromptSuggestionReactor.logic.ts";

const TURN = TurnId.makeUnsafe("turn-2");
const at = (second: number) => `2026-10-16T10:00:${String(second).padStart(2, "0")}.000Z`;
const message = (id: string, role: "user" | "assistant", text: string, second: number) => ({
  id: MessageId.makeUnsafe(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: at(second),
  updatedAt: at(second),
});
const activity = (kind: string, payload: unknown) => ({
  id: EventId.makeUnsafe(`${kind}-${JSON.stringify(payload)}`),
  tone: "info" as const,
  kind,
  summary: kind,
  payload,
  turnId: TURN,
  createdAt: at(5),
});

const thread = (overrides: Partial<OrchestrationThread> = {}) =>
  ({
    id: ThreadId.makeUnsafe("thread-1"),
    interactionMode: "default",
    latestTurn: {
      turnId: TURN,
      state: "completed",
      requestedAt: at(3),
      startedAt: at(3),
      completedAt: at(9),
      assistantMessageId: null,
    },
    session: { status: "ready", activeTurnId: null },
    queuedPrompts: [],
    archivedAt: null,
    deletingAt: null,
    deletedAt: null,
    activities: [],
    messages: [
      message("u1", "user", "Split the parser", 1),
      message("a1", "assistant", "Split into two modules.", 2),
      message("u2", "user", "Now add a lexer", 3),
      message("a2", "assistant", "Added the lexer.", 8),
    ],
    ...overrides,
  }) as unknown as OrchestrationThread;

describe("generated prompt suggestion eligibility", () => {
  it("runs after a successful turn that is not the first", () => {
    expect(generatedSuggestionSkipReason(thread(), TURN)).toBeNull();
  });

  it("skips the first turn, plan mode, failed turns and archived threads", () => {
    const first = thread({ messages: thread().messages.slice(0, 2) });
    expect(generatedSuggestionSkipReason(first, TURN)).toBe("first-turn");
    expect(generatedSuggestionSkipReason(thread({ interactionMode: "plan" }), TURN)).toBe("plan");
    const failed = thread({ latestTurn: { ...thread().latestTurn!, state: "error" } });
    expect(generatedSuggestionSkipReason(failed, TURN)).toBe("not-attachable");
    expect(generatedSuggestionSkipReason(thread({ archivedAt: at(9) }), TURN)).toBe(
      "not-attachable",
    );
  });

  it("skips while an approval or user input is pending", () => {
    const pending = thread({
      activities: [activity("approval.requested", { requestId: "r1" })] as never,
    });
    expect(generatedSuggestionSkipReason(pending, TURN)).toBe("pending-request");
    const resolved = thread({
      activities: [
        activity("user-input.requested", { requestId: "r2" }),
        activity("user-input.resolved", { requestId: "r2" }),
      ] as never,
    });
    expect(generatedSuggestionSkipReason(resolved, TURN)).toBeNull();
  });

  it("skips a turn that already has a suggestion", () => {
    const suggested = thread({
      activities: [
        activity("prompt.suggestion", {
          suggestion: "Add tests for the lexer",
          source: "native",
          provider: "claudeAgent",
        }),
      ] as never,
    });
    expect(generatedSuggestionSkipReason(suggested, TURN)).toBe("already-suggested");
  });
});

describe("generated prompt suggestion transcript", () => {
  it("keeps only recent user and assistant text, redacted and bounded", () => {
    const messages = [
      message("s", "system" as never, "system note", 0),
      message("u1", "user", "Use token=abc123 for the API", 1),
      message("a1", "assistant", "x".repeat(5_000), 2),
    ];
    const transcript = buildPromptSuggestionTranscript(messages as never);
    expect(transcript).not.toContain("system note");
    expect(transcript).not.toContain("abc123");
    expect(transcript.startsWith("USER:")).toBe(true);
    expect(transcript.length).toBeLessThanOrEqual(6_000);
  });
});

describe("generated prompt suggestion cancellation", () => {
  const threadId = ThreadId.makeUnsafe("thread-1");
  it("cancels on a user message, a new turn, a queued prompt, revert, archive or deletion", () => {
    for (const type of [
      "thread.turn-start-requested",
      "thread.prompt-queued",
      "thread.reverted",
      "thread.archived",
      "thread.deletion-requested",
    ]) {
      expect(promptSuggestionCancelThreadId({ type, payload: { threadId } } as never)).toBe(
        threadId,
      );
    }
    expect(
      promptSuggestionCancelThreadId({
        type: "thread.message-sent",
        payload: { threadId, role: "user" },
      } as never),
    ).toBe(threadId);
    expect(
      promptSuggestionCancelThreadId({
        type: "thread.message-sent",
        payload: { threadId, role: "assistant" },
      } as never),
    ).toBeNull();
  });
});
