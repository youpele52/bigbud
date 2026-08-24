import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type ProviderRuntimeEvent,
} from "@bigbud/contracts";
import { Effect, ServiceMap } from "effect";
import { describe, expect, it } from "vitest";

import { startEventStream } from "../../provider/Layers/Opencode/Adapter.stream.ts";
import type { ActiveOpencodeSession } from "../../provider/Layers/Opencode/Adapter.types.ts";
import {
  asEventId,
  asItemId,
  asMessageId,
  asThreadId,
  asTurnId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

function emptyEventStream(): AsyncIterable<never> {
  return { async *[Symbol.asyncIterator]() {} };
}

function recoverySession(
  threadId: ReturnType<typeof asThreadId>,
  turnId: ReturnType<typeof asTurnId>,
) {
  let sessionCreates = 0;
  const record = {
    client: {
      event: { subscribe: async () => ({ stream: emptyEventStream() }) },
      session: {
        create: async () => {
          sessionCreates += 1;
          throw new Error("recovery must not create a native session");
        },
      },
    },
    releaseServer() {},
    opencodeSessionId: "opencode-recovery-session",
    threadId,
    createdAt: "2026-08-18T00:00:00.000Z",
    runtimeMode: "full-access",
    sessionEpoch: 0,
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    pendingPermissions: new Map(),
    pendingUserInputs: new Map(),
    turns: [],
    sseAbortController: null,
    cwd: undefined,
    model: undefined,
    providerID: undefined,
    updatedAt: "2026-08-18T00:00:00.000Z",
    lastError: undefined,
    activeTurnId: turnId,
    lastUsage: undefined,
    wasRetrying: false,
    reasoningPartIds: new Set(),
    allowedTools: {},
  } as unknown as ActiveOpencodeSession;
  return {
    record,
    get sessionCreates() {
      return sessionCreates;
    },
  };
}

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

  it("keeps recovery exhaustion turn-scoped through dispatch and queue safety", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("opencode-recovery-turn");
    const createdAt = new Date().toISOString();

    harness.setProviderSession({
      provider: "opencode",
      status: "running",
      runtimeMode: "approval-required",
      sessionEpoch: 0,
      threadId,
      activeTurnId: turnId,
      createdAt,
      updatedAt: createdAt,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-opencode-recovery-turn-started"),
      provider: "opencode",
      threadId,
      turnId,
      createdAt,
    });
    await waitForThread(harness.engine, (thread) => thread.session?.activeTurnId === turnId);

    const native = recoverySession(threadId, turnId);
    const owner = startEventStream(
      native.record,
      () => Effect.void,
      ((
        _threadId: ReturnType<typeof asThreadId>,
        sessionEpoch: number,
        type: string,
        payload: unknown,
        extra?: { readonly turnId?: ReturnType<typeof asTurnId> },
      ) =>
        Effect.succeed({
          eventId: EventId.makeUnsafe("evt-opencode-recovery-exhausted"),
          provider: "opencode",
          threadId: _threadId,
          sessionEpoch,
          createdAt: new Date().toISOString(),
          type,
          ...(extra?.turnId ? { turnId: extra.turnId } : {}),
          payload,
        } as never)) as never,
      (events) => Effect.sync(() => events.forEach(harness.emit)),
      ServiceMap.empty(),
      undefined,
      { retryDelays: [0, 0, 0], random: () => 0 },
    );
    const recovering = await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.activeTurnId === turnId && thread.session.reason === "provider.recovering",
    );
    expect(recovering.session?.status).toBe("error");
    expect(native.record.activeTurnId).toBe(turnId);
    expect(native.sessionCreates).toBe(0);
    owner.stop();

    await expect(
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-direct-start-during-recovery"),
          threadId,
          message: {
            messageId: asMessageId("message-attachment-during-recovery"),
            role: "user",
            text: "summarize this attachment",
            attachments: [
              {
                type: "file",
                id: "thread-attachment-00000000-0000-4000-8000-000000000020",
                name: "report.txt",
                mimeType: "text/plain",
                sizeBytes: 12,
                sourcePath: "/tmp/report.txt",
              },
            ],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toThrow("has an unresolved turn");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.submit",
        commandId: CommandId.makeUnsafe("cmd-queue-during-recovery"),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe("message-ordinary-during-recovery"),
          text: "ordinary follow-up",
        },
        delivery: "auto",
        createdAt: new Date().toISOString(),
      }),
    );
    const queued = await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.activeTurnId === turnId &&
        thread.queuedPrompts?.some((prompt) => prompt.text === "ordinary follow-up") === true,
    );
    expect(queued.queuedPrompts).toHaveLength(1);
    expect(queued.latestTurn?.turnId).toBe(turnId);
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
