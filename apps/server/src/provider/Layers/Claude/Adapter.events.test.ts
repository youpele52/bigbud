import { EventId, ThreadId } from "@bigbud/contracts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { ClaudeSessionContext } from "./Adapter.types.ts";
import { deleteClaudeSessionIfCurrent, makeClaudeEventRuntime } from "./Adapter.events.ts";

function context(threadId: ReturnType<typeof ThreadId.makeUnsafe>, sessionEpoch: number) {
  return {
    sessionEpoch,
    session: { threadId },
  } as ClaudeSessionContext;
}

describe("Claude event provenance", () => {
  it("discards late events from a replaced context and stamps the replacement epoch", async () => {
    const threadId = ThreadId.makeUnsafe("claude-overlap-event");
    const oldContext = context(threadId, 1);
    const replacement = context(threadId, 2);
    const sessions = new Map([[threadId, replacement]]);
    expect(deleteClaudeSessionIfCurrent(sessions, oldContext)).toBe(false);
    expect(sessions.get(threadId)).toBe(replacement);
    const runtime = await Effect.runPromise(makeClaudeEventRuntime(sessions));
    const event = {
      type: "session.exited" as const,
      eventId: EventId.makeUnsafe("event"),
      provider: "claudeAgent" as const,
      createdAt: "2026-08-30T00:00:00.000Z",
      threadId,
      payload: { reason: "Session stopped", exitKind: "graceful" as const },
      providerRefs: {},
    };

    await Effect.runPromise(runtime.offerRuntimeEvent(oldContext, event));
    await Effect.runPromise(
      runtime.offerRuntimeEvent(replacement, {
        ...event,
        eventId: EventId.makeUnsafe("replacement"),
      }),
    );
    const received = await Effect.runPromise(Stream.runHead(runtime.stream));
    expect(Option.getOrThrow(received)).toMatchObject({
      eventId: "replacement",
      sessionEpoch: 2,
    });
    await Effect.runPromise(runtime.shutdown);
  });
});
