import { ApprovalRequestId, EventId, ThreadId } from "@bigbud/contracts";
import { Effect, Deferred } from "effect";
import type * as EffectAcpErrors from "effect-acp/errors";
import { describe, expect, it } from "vitest";

import type { AcpSessionRuntimeShape } from "../../acp/AcpSessionRuntime.ts";
import { CursorAskQuestionRequest, CursorCreatePlanRequest } from "../../acp/CursorAcpExtension.ts";
import { createFakeAcpSessionRuntime } from "../../acp/AcpSessionRuntime.test.helpers.ts";
import { type PendingUserInput } from "./Adapter.helpers.ts";
import { registerCursorExtensionHandlers } from "./Adapter.startSession.extensions.ts";
import { settlePendingUserInputsAsCancelled } from "./Adapter.helpers.ts";

type ExtensionRequestHandler = (
  payload: unknown,
) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;

const threadId = ThreadId.makeUnsafe("cursor-extension-test");

function makeExtensionHarness() {
  const handlers = new Map<string, ExtensionRequestHandler>();
  const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
  const events: unknown[] = [];
  const baseRuntime = createFakeAcpSessionRuntime();
  const acp = {
    ...baseRuntime,
    handleExtRequest: (method: string, _schema: unknown, handler: ExtensionRequestHandler) =>
      Effect.sync(() => {
        handlers.set(method, handler);
      }),
  } as AcpSessionRuntimeShape;

  const registration = registerCursorExtensionHandlers({
    acp,
    nativeEventLogger: undefined,
    pendingUserInputs,
    sessionEpoch: 7,
    threadId,
    getSessionContext: () => undefined,
    makeEventStamp: () =>
      Effect.succeed({
        eventId: EventId.makeUnsafe(`event-${events.length}`),
        createdAt: "2026-09-03T00:00:00.000Z",
      }),
    offerRuntimeEvent: (event) => Effect.sync(() => events.push(event)),
  });

  return { events, handlers, pendingUserInputs, registration };
}

const askRequest = {
  toolCallId: "tool-1",
  questions: [
    {
      id: "model",
      prompt: "Choose a model",
      options: [{ id: "model-fast", label: "Fast" }],
    },
  ],
} satisfies typeof CursorAskQuestionRequest.Type;

describe("Cursor ACP extension handlers", () => {
  it("round-trips answered option ids and finalizes the pending map", async () => {
    const harness = makeExtensionHarness();
    await Effect.runPromise(harness.registration);
    const handler = harness.handlers.get("cursor/ask_question");
    if (!handler) throw new Error("ask-question handler was not registered");

    const responsePromise = Effect.runPromise(handler(askRequest));
    await viWaitForPending(harness.pendingUserInputs);
    const pending = [...harness.pendingUserInputs.values()][0];
    if (!pending) throw new Error("pending input was not registered");
    await Effect.runPromise(
      Deferred.succeed(pending.resolution, {
        outcome: "answered",
        answers: { model: "model-fast" },
      }),
    );

    await expect(responsePromise).resolves.toEqual({
      outcome: {
        outcome: "answered",
        answers: [{ questionId: "model", selectedOptionIds: ["model-fast"] }],
      },
    });
    expect(harness.pendingUserInputs.size).toBe(0);
    expect(harness.events.map((event) => (event as { type: string }).type)).toEqual([
      "user-input.requested",
      "user-input.resolved",
    ]);
  });

  it("returns Cursor cancellation after interruption and cleans up the pending map", async () => {
    const harness = makeExtensionHarness();
    await Effect.runPromise(harness.registration);
    const handler = harness.handlers.get("cursor/ask_question");
    if (!handler) throw new Error("ask-question handler was not registered");

    const responsePromise = Effect.runPromise(handler(askRequest));
    await viWaitForPending(harness.pendingUserInputs);
    await Effect.runPromise(settlePendingUserInputsAsCancelled(harness.pendingUserInputs));

    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(harness.pendingUserInputs.size).toBe(0);
  });

  it("returns the documented plan acceptance envelope", async () => {
    const harness = makeExtensionHarness();
    await Effect.runPromise(harness.registration);
    const handler = harness.handlers.get("cursor/create_plan");
    if (!handler) throw new Error("create-plan handler was not registered");

    await expect(
      Effect.runPromise(
        handler({
          toolCallId: "tool-plan",
          plan: "# Plan",
          todos: [],
        } satisfies typeof CursorCreatePlanRequest.Type),
      ),
    ).resolves.toEqual({ outcome: { outcome: "accepted" } });
  });
});

async function viWaitForPending(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Promise<void> {
  for (let attempt = 0; attempt < 20 && pendingUserInputs.size === 0; attempt += 1) {
    await Promise.resolve();
  }
}
