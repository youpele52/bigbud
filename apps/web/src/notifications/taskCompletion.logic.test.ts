import { describe, expect, it } from "vitest";

import { collectCompletedThreadCandidates } from "./taskCompletion.logic";
import type { Thread } from "../models/types";

function makeThread(overrides?: Partial<Thread>): Thread {
  return {
    id: "thread-1" as never,
    codexThreadId: null,
    projectId: "project-1" as never,
    title: "Fix toaster state",
    modelSelection: { provider: "codex", model: "gpt-5" } as never,
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-06-17T18:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-06-17T18:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("collectCompletedThreadCandidates", () => {
  it("ignores Sidecar completions", () => {
    const previous = makeThread({ purpose: "side-chat" });
    const next = makeThread({
      purpose: "side-chat",
      latestTurn: {
        turnId: "turn-sidecar" as never,
        state: "completed",
        requestedAt: "2026-06-17T18:00:00.000Z",
        startedAt: "2026-06-17T18:00:00.000Z",
        completedAt: "2026-06-17T18:00:05.000Z",
        assistantMessageId: null,
      },
      session: {
        provider: "codex",
        status: "ready",
        createdAt: "2026-06-17T18:00:00.000Z",
        updatedAt: "2026-06-17T18:00:05.000Z",
        orchestrationStatus: "ready",
      },
    });

    expect(collectCompletedThreadCandidates([previous], [next])).toEqual([]);
  });

  it("does not emit when the assistant message arrives before the session has actually settled", () => {
    const previous = makeThread({
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        requestedAt: "2026-06-17T18:00:00.000Z",
        startedAt: "2026-06-17T18:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: "turn-1" as never,
        createdAt: "2026-06-17T18:00:00.000Z",
        updatedAt: "2026-06-17T18:00:01.000Z",
        orchestrationStatus: "running",
      },
    });

    const next = makeThread({
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        requestedAt: "2026-06-17T18:00:00.000Z",
        startedAt: "2026-06-17T18:00:00.000Z",
        completedAt: "2026-06-17T18:00:05.000Z",
        assistantMessageId: "assistant-1" as never,
      },
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: "turn-1" as never,
        createdAt: "2026-06-17T18:00:00.000Z",
        updatedAt: "2026-06-17T18:00:05.000Z",
        orchestrationStatus: "running",
      },
      messages: [
        {
          id: "assistant-1" as never,
          role: "assistant",
          text: "Implemented the first step.",
          turnId: "turn-1" as never,
          createdAt: "2026-06-17T18:00:05.000Z",
          completedAt: "2026-06-17T18:00:05.000Z",
          streaming: false,
        },
      ],
    });

    expect(collectCompletedThreadCandidates([previous], [next])).toEqual([]);
  });

  it("emits once when the thread enters the same completed state shown in the plan card", () => {
    const previous = makeThread({
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        requestedAt: "2026-06-17T18:00:00.000Z",
        startedAt: "2026-06-17T18:00:00.000Z",
        completedAt: "2026-06-17T18:00:05.000Z",
        assistantMessageId: "assistant-1" as never,
      },
      session: {
        provider: "codex",
        status: "running",
        activeTurnId: "turn-1" as never,
        createdAt: "2026-06-17T18:00:00.000Z",
        updatedAt: "2026-06-17T18:00:05.000Z",
        orchestrationStatus: "running",
      },
      messages: [
        {
          id: "assistant-1" as never,
          role: "assistant",
          text: "Implemented the fix and verified it.",
          turnId: "turn-1" as never,
          createdAt: "2026-06-17T18:00:05.000Z",
          completedAt: "2026-06-17T18:00:05.000Z",
          streaming: false,
        },
      ],
    });

    const next = makeThread({
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        requestedAt: "2026-06-17T18:00:00.000Z",
        startedAt: "2026-06-17T18:00:00.000Z",
        completedAt: "2026-06-17T18:00:05.000Z",
        assistantMessageId: "assistant-1" as never,
      },
      session: {
        provider: "codex",
        status: "ready",
        createdAt: "2026-06-17T18:00:00.000Z",
        updatedAt: "2026-06-17T18:00:06.000Z",
        orchestrationStatus: "ready",
      },
      messages: [
        {
          id: "assistant-1" as never,
          role: "assistant",
          text: "Implemented the fix and verified it.",
          turnId: "turn-1" as never,
          createdAt: "2026-06-17T18:00:05.000Z",
          completedAt: "2026-06-17T18:00:05.000Z",
          streaming: false,
        },
      ],
    });

    expect(collectCompletedThreadCandidates([previous], [next])).toMatchObject([
      {
        threadId: "thread-1",
        title: "Fix toaster state",
        completedAt: "2026-06-17T18:00:05.000Z",
      },
    ]);
  });
});
