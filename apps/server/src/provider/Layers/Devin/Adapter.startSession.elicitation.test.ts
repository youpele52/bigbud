import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import { EventId, ThreadId, type ApprovalRequestId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import type { AcpSessionRuntimeShape } from "../../acp/AcpSessionRuntime.ts";
import type { PendingUserInput } from "./Adapter.helpers.ts";
import { registerDevinElicitationHandler } from "./Adapter.startSession.elicitation.ts";

type Handler = (params: unknown) => Effect.Effect<unknown>;

function setup() {
  let handler: Handler | undefined;
  let method: string | undefined;
  const acp = {
    handleExtRequest: (name: string, _schema: unknown, next: Handler) =>
      Effect.sync(() => {
        method = name;
        handler = next;
      }),
  } as unknown as AcpSessionRuntimeShape;
  const events: ProviderRuntimeEvent[] = [];
  const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
  const register = registerDevinElicitationHandler({
    acp,
    threadId: ThreadId.makeUnsafe("devin-thread"),
    sessionEpoch: 2,
    pendingUserInputs,
    nativeEventLogger: undefined,
    getActiveTurnId: () => undefined,
    makeEventStamp: () =>
      Effect.succeed({
        eventId: EventId.makeUnsafe(crypto.randomUUID()),
        createdAt: "2026-11-13T00:00:00.000Z",
      }),
    offerRuntimeEvent: (event) => Effect.sync(() => void events.push(event)),
  });
  return { register, events, pendingUserInputs, method: () => method, handler: () => handler! };
}

const request = {
  mode: "form",
  requestedSchema: {
    properties: {
      q0: { type: "string", title: "Environment", oneOf: [{ const: "Staging", title: "Staging" }] },
    },
    required: ["q0"],
  },
  _meta: { "cognition.ai/allowOther": true },
};

describe("Devin elicitation handler", () => {
  it("opens a native question and answers Devin with the user's choice", async () => {
    const harness = setup();
    await Effect.runPromise(harness.register);
    expect(harness.method()).toBe("elicitation/create");
    const fiber = Effect.runFork(harness.handler()(request));
    await expect.poll(() => harness.pendingUserInputs.size).toBe(1);
    expect(harness.events[0]).toMatchObject({
      type: "user-input.requested",
      provider: "devin",
      sessionEpoch: 2,
      payload: { questions: [{ id: "q0", header: "Environment" }] },
    });
    const [pending] = harness.pendingUserInputs.values();
    await Effect.runPromise(Deferred.succeed(pending!.answers, { q0: "Staging" }));
    const result = await Effect.runPromise(Fiber.join(fiber));
    expect(result).toEqual({ action: "accept", content: { q0: "Staging" } });
    expect(harness.events[1]).toMatchObject({
      type: "user-input.resolved",
      payload: { answers: { q0: "Staging" } },
    });
    expect(harness.pendingUserInputs.size).toBe(0);
  });

  it("cancels when the session stops with the question unanswered", async () => {
    const harness = setup();
    await Effect.runPromise(harness.register);
    const fiber = Effect.runFork(harness.handler()(request));
    await expect.poll(() => harness.pendingUserInputs.size).toBe(1);
    const [pending] = harness.pendingUserInputs.values();
    // Session stop settles pending questions with empty answers.
    await Effect.runPromise(Deferred.succeed(pending!.answers, {}));
    expect(await Effect.runPromise(Fiber.join(fiber))).toEqual({ action: "cancel" });
  });

  it("declines URL elicitation without opening a question", async () => {
    const harness = setup();
    await Effect.runPromise(harness.register);
    const result = await Effect.runPromise(harness.handler()({ mode: "url", url: "https://x" }));
    expect(result).toEqual({ action: "decline" });
    expect(harness.events).toEqual([]);
  });
});
