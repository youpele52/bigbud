import { ApprovalRequestId, CommandId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asEventId,
  asThreadId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

const threadId = asThreadId("thread-1");

/**
 * F-B4: a provider event that arrives after its thread was evicted from the engine read model is
 * applied, not dropped. Ingestion hydrates the thread before it reads or dispatches.
 */
describe("ProviderRuntimeIngestion after read-model eviction", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it("rehydrates an evicted thread and applies a late provider event", async () => {
    const clock = { now: 0 };
    const harness = await createHarness({
      residency: {
        bounds: { maxResidentThreads: 10, idleTtlMs: 1_000, minResidencyMs: 100, batch: 10 },
        nowMs: () => clock.now,
      },
    });
    const engine = harness.engine;
    const createdAt = new Date().toISOString();
    // A ready session keeps the thread resident; only a stopped one may be evicted.
    const evictOnce = () =>
      Effect.runPromise(engine.evictIdleThreads!({ isHeld: () => Effect.succeed(false) }));
    clock.now = 10_000;
    expect((await evictOnce()).evicted).toBe(0);
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-stopped"),
        threadId,
        session: {
          threadId,
          status: "stopped",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          reason: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    clock.now = 20_000;
    expect((await evictOnce()).evicted).toBe(1);
    const before = await Effect.runPromise(engine.getReadModel());
    expect(before.threads.some((thread) => thread.id === threadId)).toBe(false);

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-late-request"),
      provider: "codex",
      createdAt,
      threadId,
      requestId: ApprovalRequestId.makeUnsafe("req-late"),
      payload: { requestType: "command_execution_approval", detail: "pwd" },
    });
    await harness.drain();

    const thread = await waitForThread(engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "approval.requested"),
    );
    expect(thread.title).toBe("Thread");
    expect(thread.session?.status).toBe("stopped");
    // The applied event is durable, not only in memory.
    const persisted = await harness.getPersistedSnapshot();
    expect(
      persisted.threads
        .find((entry) => entry.id === threadId)
        ?.activities.some((activity) => activity.kind === "approval.requested"),
    ).toBe(true);
  });
});
