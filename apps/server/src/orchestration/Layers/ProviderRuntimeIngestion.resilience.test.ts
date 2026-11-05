import { CommandId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asEventId,
  asItemId,
  asThreadId,
  asTurnId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

describe("ProviderRuntimeIngestion", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });

  it("rejects a stale recovery event after a newer local turn replaces it", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const oldTurnId = asTurnId("opencode-recovery-old-turn");
    const newTurnId = asTurnId("opencode-recovery-new-turn");
    const createdAt = new Date().toISOString();

    harness.setProviderSession({
      provider: "opencode",
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: oldTurnId,
      createdAt,
      updatedAt: createdAt,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-opencode-old-turn-started"),
      provider: "opencode",
      threadId,
      turnId: oldTurnId,
      createdAt,
    });
    await waitForThread(harness.engine, (thread) => thread.session?.activeTurnId === oldTurnId);

    harness.setProviderSession({
      provider: "opencode",
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: newTurnId,
      createdAt,
      updatedAt: new Date().toISOString(),
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-replace-recovery-turn"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "opencode",
          runtimeMode: "approval-required",
          activeTurnId: newTurnId,
          reason: null,
          lastError: null,
          updatedAt: new Date().toISOString(),
        },
        createdAt: new Date().toISOString(),
      }),
    );

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-opencode-stale-recovery"),
      provider: "opencode",
      threadId,
      turnId: oldTurnId,
      createdAt: new Date().toISOString(),
      payload: { state: "error", reason: "provider.recovering" },
    });
    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-opencode-unscoped-recovery"),
      provider: "opencode",
      threadId,
      createdAt: new Date().toISOString(),
      payload: { state: "error", reason: "provider.recovering" },
    });

    const preserved = await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === newTurnId,
    );
    expect(preserved.session).toMatchObject({
      status: "running",
      activeTurnId: newTurnId,
      reason: null,
    });
  });
});
