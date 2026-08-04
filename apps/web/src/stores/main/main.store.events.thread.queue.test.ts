import { MessageId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvent, applyOrchestrationEvents } from "./events.store";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

const queuedPrompt = (id: string, text: string) => ({
  id: MessageId.makeUnsafe(id),
  text,
  createdAt: "2026-08-04T10:00:00.000Z",
});

describe("incremental queued-prompt updates", () => {
  it("projects a busy-thread prompt into the live queue without changing another thread", () => {
    const target = makeThread({ id: ThreadId.makeUnsafe("thread-target") });
    const unrelated = makeThread({ id: ThreadId.makeUnsafe("thread-unrelated") });
    const state = { ...makeState(target), threads: [target, unrelated] };
    const prompt = queuedPrompt("prompt-1", "Review the current approach");

    const next = applyOrchestrationEvent(
      state,
      makeEvent(
        "thread.prompt-queued",
        { threadId: target.id, prompt, queuePosition: 1 },
        { occurredAt: "2026-08-04T10:00:01.000Z" },
      ),
    );

    expect(next.threads[0]?.queuedPrompts).toEqual([prompt]);
    expect(next.threads[0]?.updatedAt).toBe("2026-08-04T10:00:01.000Z");
    expect(next.threads[1]).toBe(unrelated);
  });

  it("does not duplicate a queued prompt when an event is replayed", () => {
    const prompt = queuedPrompt("prompt-1", "Keep this idempotent");
    const thread = makeThread({ queuedPrompts: [prompt] });
    const state = makeState(thread);

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.prompt-queued", {
        threadId: thread.id,
        prompt,
        queuePosition: 1,
      }),
    );

    expect(next).toBe(state);
    expect(next.threads[0]?.queuedPrompts).toEqual([prompt]);
  });

  it("removes one prompt and flushes the acknowledged prompt prefix", () => {
    const first = queuedPrompt("prompt-1", "First");
    const second = queuedPrompt("prompt-2", "Second");
    const third = queuedPrompt("prompt-3", "Third");
    const thread = makeThread({ queuedPrompts: [first, second, third] });

    const next = applyOrchestrationEvents(makeState(thread), [
      makeEvent(
        "thread.queued-prompt-removed",
        { threadId: thread.id, messageId: second.id },
        { sequence: 2 },
      ),
      makeEvent(
        "thread.queued-prompts-flushed",
        { threadId: thread.id, messageIds: [first.id] },
        { sequence: 3 },
      ),
    ]);

    expect(next.threads[0]?.queuedPrompts).toEqual([third]);
  });
});
