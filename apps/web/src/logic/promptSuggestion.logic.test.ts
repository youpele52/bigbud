import { EventId, MessageId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { deriveVisiblePromptSuggestion } from "./promptSuggestion.logic";

const TURN = TurnId.makeUnsafe("turn-2");
const at = (second: number) => `2026-10-16T10:00:${String(second).padStart(2, "0")}.000Z`;
const suggestion = (id: string, text: string, turnId = TURN, second = 10) => ({
  id: EventId.makeUnsafe(id),
  tone: "info" as const,
  kind: "prompt.suggestion",
  summary: "Suggested next prompt",
  payload: { suggestion: text, source: "native", provider: "claudeAgent" },
  turnId,
  createdAt: at(second),
});
const message = (id: string, role: "user" | "assistant", second: number) => ({
  id: MessageId.makeUnsafe(id),
  role,
  text: id,
  createdAt: at(second),
  streaming: false,
});

type Input = Parameters<typeof deriveVisiblePromptSuggestion>[0];
const thread = (overrides: Partial<Input> = {}): Input =>
  ({
    latestTurn: {
      turnId: TURN,
      state: "completed",
      requestedAt: at(1),
      startedAt: at(1),
      completedAt: at(9),
      assistantMessageId: null,
    },
    session: { status: "ready", orchestrationStatus: "ready", activeTurnId: undefined },
    queuedPrompts: [],
    archivedAt: null,
    messages: [message("u1", "user", 1), message("a1", "assistant", 8)],
    activities: [
      suggestion("old", "An older suggestion text", TurnId.makeUnsafe("turn-1"), 5),
      suggestion("new", "Add tests for the new parser"),
    ],
    ...overrides,
  }) as unknown as Input;

describe("deriveVisiblePromptSuggestion", () => {
  it("shows the newest suggestion of the latest settled turn", () => {
    expect(deriveVisiblePromptSuggestion(thread(), true)).toEqual({
      suggestion: "Add tests for the new parser",
      source: "native",
      provider: "claudeAgent",
      turnId: TURN,
    });
  });

  it("is cleared by a new turn, a send or a queued prompt", () => {
    const newTurn = thread({
      latestTurn: { ...thread().latestTurn!, turnId: TurnId.makeUnsafe("turn-3") },
    });
    expect(deriveVisiblePromptSuggestion(newTurn, true)).toBeNull();
    const sent = thread({ messages: [...thread().messages, message("u2", "user", 11)] });
    expect(deriveVisiblePromptSuggestion(sent, true)).toBeNull();
    const queued = thread({ queuedPrompts: [{ id: "q1" }] as never });
    expect(deriveVisiblePromptSuggestion(queued, true)).toBeNull();
  });

  it("is hidden while a turn runs, after a failed turn, when archived or disabled", () => {
    const running = thread({
      session: { status: "running", orchestrationStatus: "running", activeTurnId: TURN } as never,
    });
    expect(deriveVisiblePromptSuggestion(running, true)).toBeNull();
    const failed = thread({ latestTurn: { ...thread().latestTurn!, state: "error" } });
    expect(deriveVisiblePromptSuggestion(failed, true)).toBeNull();
    expect(deriveVisiblePromptSuggestion(thread({ archivedAt: at(9) }), true)).toBeNull();
    expect(deriveVisiblePromptSuggestion(thread(), false)).toBeNull();
  });

  it("is gone after a revert dropped the suggestion activity", () => {
    expect(deriveVisiblePromptSuggestion(thread({ activities: [] }), true)).toBeNull();
  });
});
