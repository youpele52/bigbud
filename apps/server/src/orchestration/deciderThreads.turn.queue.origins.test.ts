import { MessageId, ThreadId, type OrchestrationQueuedPrompt } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { attributedSegments } from "./deciderThreads.turn.queue.ts";

function prompt(text: string, source?: string): OrchestrationQueuedPrompt {
  return {
    id: MessageId.makeUnsafe(text),
    text,
    createdAt: "2026-09-28T12:00:00.000Z",
    ...(source
      ? {
          originSegments: [
            {
              kind: "crossThreadAgent",
              actor: "agent",
              text,
              sourceThreads: [{ threadId: ThreadId.makeUnsafe(source), title: source }],
              verified: true,
            },
          ],
        }
      : {}),
  };
}

describe("queued prompt origin attribution", () => {
  it("preserves ordered agent A, ordinary user, and agent B segments", () => {
    const segments = [prompt("A", "source-a"), prompt("User"), prompt("B", "source-b")].flatMap(
      attributedSegments,
    );
    expect(
      segments.map((segment) => ({
        actor: segment.actor,
        text: segment.text,
        source: segment.sourceThreads[0]?.threadId,
      })),
    ).toEqual([
      { actor: "agent", text: "A", source: "source-a" },
      { actor: "user", text: "User", source: undefined },
      { actor: "agent", text: "B", source: "source-b" },
    ]);
  });
});
