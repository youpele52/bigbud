import { EventId, MessageId, type OrchestrationThread, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  buildPromptSuggestionActivity,
  isPromptSuggestionAttachable,
} from "./promptSuggestion.logic.ts";

const TURN = TurnId.makeUnsafe("turn-2");
const at = (second: number) => `2026-10-16T10:00:${String(second).padStart(2, "0")}.000Z`;
const message = (id: string, role: "user" | "assistant", text: string, second: number) => ({
  id: MessageId.makeUnsafe(id),
  role,
  text,
  turnId: TURN,
  streaming: false,
  createdAt: at(second),
  updatedAt: at(second),
});

type Thread = Parameters<typeof isPromptSuggestionAttachable>[0];
const settled = (overrides: Partial<OrchestrationThread> = {}): Thread =>
  ({
    id: ThreadId.makeUnsafe("thread-1"),
    latestTurn: {
      turnId: TURN,
      state: "completed",
      requestedAt: at(1),
      startedAt: at(1),
      completedAt: at(9),
      assistantMessageId: null,
    },
    session: { status: "ready", activeTurnId: null },
    queuedPrompts: [],
    archivedAt: null,
    deletingAt: null,
    deletedAt: null,
    messages: [
      message("u1", "user", "Refactor the parser", 1),
      message("a1", "assistant", "Done, the parser is split.", 8),
    ],
    ...overrides,
  }) as unknown as Thread;

const build = (thread: Thread, raw: string, turnId: TurnId | null = TURN) =>
  buildPromptSuggestionActivity({
    thread,
    turnId,
    raw,
    source: "native",
    provider: "claudeAgent",
    eventId: EventId.makeUnsafe("evt-suggestion"),
    createdAt: at(10),
  });

describe("prompt suggestion attachment", () => {
  it("attaches a normalized suggestion to the latest settled turn", () => {
    expect(build(settled(), "  Add tests for\nthe new parser ")).toEqual({
      id: "evt-suggestion",
      createdAt: at(10),
      tone: "info",
      kind: "prompt.suggestion",
      summary: "Suggested next prompt",
      payload: {
        suggestion: "Add tests for the new parser",
        source: "native",
        provider: "claudeAgent",
      },
      turnId: TURN,
    });
  });

  it("accepts a turn whose checkpoint is not captured yet once the session is idle", () => {
    const thread = settled({
      latestTurn: { ...settled().latestTurn!, state: "running", completedAt: null },
    });
    expect(isPromptSuggestionAttachable(thread, TURN)).toBe(true);
  });

  it("never attaches to a stale, failed, interrupted or running turn", () => {
    expect(isPromptSuggestionAttachable(settled(), TurnId.makeUnsafe("turn-1"))).toBe(false);
    expect(isPromptSuggestionAttachable(settled(), null)).toBe(false);
    for (const state of ["error", "interrupted"] as const) {
      const thread = settled({ latestTurn: { ...settled().latestTurn!, state } });
      expect(isPromptSuggestionAttachable(thread, TURN)).toBe(false);
    }
    const running = settled({
      session: { status: "running", activeTurnId: TurnId.makeUnsafe("turn-3") } as never,
    });
    expect(isPromptSuggestionAttachable(running, TURN)).toBe(false);
  });

  it("is cleared by a send or a queued prompt", () => {
    const sent = settled({
      messages: [...settled().messages, message("u2", "user", "Next question", 11)],
    });
    expect(isPromptSuggestionAttachable(sent, TURN)).toBe(false);
    const queued = settled({ queuedPrompts: [{ id: MessageId.makeUnsafe("q1") }] as never });
    expect(isPromptSuggestionAttachable(queued, TURN)).toBe(false);
  });

  it("never attaches to an archived or deleting thread", () => {
    expect(isPromptSuggestionAttachable(settled({ archivedAt: at(9) }), TURN)).toBe(false);
    expect(isPromptSuggestionAttachable(settled({ deletingAt: at(9) }), TURN)).toBe(false);
  });

  it("drops an out-of-range suggestion or one equal to the last user message", () => {
    expect(build(settled(), "Too short")).toBeNull();
    expect(build(settled(), "refactor the  PARSER")).toBeNull();
  });
});
