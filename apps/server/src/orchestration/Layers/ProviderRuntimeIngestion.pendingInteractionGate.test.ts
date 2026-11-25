import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  asEventId,
  asThreadId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

describe("ProviderRuntimeIngestion pending interaction gate", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it("keeps an exact gate fenced after replacement even when the original close arrives", async () => {
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const createdAt = new Date().toISOString();
    const messageId = MessageId.makeUnsafe("held-original");
    const requestId = ApprovalRequestId.makeUnsafe("original-approval");
    const generation = "original-generation";
    const gate = {
      provider: "codex" as const,
      sessionEpoch: 0,
      approvalRequests: [{ requestId, generation }],
      userInputRequests: [],
    };
    const dispatch = (command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
      Effect.runPromise(harness.engine.dispatch(command));
    await dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("original-start"),
      threadId,
      message: { messageId, role: "user", text: "Held original", attachments: [] },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      createdAt,
    });
    await dispatch({
      type: "thread.message.submit",
      commandId: CommandId.makeUnsafe("park-original"),
      threadId,
      message: { messageId, text: "Held original" },
      redeliverSentMessage: true,
      pendingInteractionGate: gate,
      delivery: "queue",
      createdAt,
    });
    await dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe("replacement-session"),
      threadId,
      advanceSessionEpoch: true,
      session: {
        threadId,
        providerName: "codex",
        runtimeMode: "full-access",
        status: "idle",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
        sessionEpoch: 1,
      },
      createdAt,
    });
    harness.emit({
      type: "request.resolved",
      eventId: asEventId("late-close"),
      provider: "codex",
      threadId,
      createdAt,
      sessionEpoch: 0,
      requestId,
      requestGeneration: generation,
      payload: { requestType: "command_execution_approval", decision: "accept" },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("current-open"),
      provider: "codex",
      threadId,
      createdAt,
      sessionEpoch: 1,
      requestId,
      requestGeneration: "replacement-generation",
      payload: { requestType: "command_execution_approval" },
    });
    await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "current-open"),
    );
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads[0];
    expect(thread?.session?.sessionEpoch).toBe(1);
    expect(thread?.queuedPrompts).toMatchObject([{ id: messageId, pendingInteractionGate: gate }]);
    expect(thread?.activities.some((activity) => activity.kind === "approval.resolved")).toBe(
      false,
    );
  });
});
