import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  model,
  now,
  operation,
  prompt,
  thread,
  threadId,
  turnId,
} from "../QueuedPromptPolicy.test.helpers.ts";
import { makeEvent } from "../projector.test.helpers.ts";
import {
  makeProcessTurnSteerRequested,
  STEER_NEEDS_NATIVE_DETAIL,
} from "./ProviderCommandReactorHandlers.steer.ts";

function harness(overrides: Partial<OrchestrationThread> = {}, options = { nativeSteer: true }) {
  const op = operation();
  const value = thread({ pendingTurnControlOperation: op, ...overrides });
  const dispatch = vi.fn((_command: OrchestrationCommand) => Effect.succeed({}));
  const steerTurn = vi.fn(() => Effect.void);
  const interruptTurn = vi.fn(() => Effect.void);
  const appendProviderFailureActivity = vi.fn(
    (_activity: { readonly kind: string; readonly detail: string }) => Effect.void,
  );
  const process = makeProcessTurnSteerRequested({
    providerService: {
      getCapabilities: () => Effect.succeed({ turnControl: { nativeSteer: options.nativeSteer } }),
      steerTurn,
      interruptTurn,
    } as unknown as ProviderServiceShape,
    orchestrationEngine: {
      dispatch,
      getReadModel: () => Effect.succeed(model(value)),
    } as unknown as OrchestrationEngineShape,
    resolveThread: () => Effect.succeed(model(value)),
    appendProviderFailureActivity,
  });
  const event = makeEvent({
    sequence: 1,
    type: "thread.turn-steer-requested",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: "control",
    payload: {
      threadId,
      turnId,
      queuedPromptIds: op.reservedPromptIds,
      operation: op,
      createdAt: now,
    },
  }) as Extract<OrchestrationEvent, { type: "thread.turn-steer-requested" }>;
  return { process, event, dispatch, steerTurn, interruptTurn, appendProviderFailureActivity };
}

function expectFailedWithoutInterrupt(h: ReturnType<typeof harness>) {
  expect(h.steerTurn).not.toHaveBeenCalled();
  expect(h.interruptTurn).not.toHaveBeenCalled();
  expect(h.dispatch.mock.calls.some(([c]) => c.type === "thread.queued-prompt.flush")).toBe(false);
  expect(h.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
    type: "thread.turn-control.set",
    operation: { state: "failed", error: STEER_NEEDS_NATIVE_DETAIL },
  });
  expect(h.appendProviderFailureActivity).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      kind: "provider.turn.steer.failed",
      detail: STEER_NEEDS_NATIVE_DETAIL,
    }),
  );
}

describe("metadata-aware queued steering", () => {
  it.each([
    { runtimeMode: "full-access" as const },
    { runtimeMode: "approval-required" as const },
    { interactionMode: "plan" as const },
    { modelSelection: { provider: "codex" as const, model: "different" } },
  ])(
    "fails without interrupting when explicit options block native steering %#",
    async (settings) => {
      const h = harness({ queuedPrompts: [{ ...prompt("one"), ...settings }, prompt("two")] });
      await Effect.runPromise(h.process(h.event));
      expectFailedWithoutInterrupt(h);
    },
  );

  it("fails without interrupting when the provider cannot steer natively", async () => {
    const h = harness({}, { nativeSteer: false });
    await Effect.runPromise(h.process(h.event));
    expectFailedWithoutInterrupt(h);
  });

  it("never natively steers an already-sent redelivery", async () => {
    const h = harness({ queuedPrompts: [{ ...prompt("one"), alreadySent: true }] });
    await Effect.runPromise(h.process(h.event));
    expectFailedWithoutInterrupt(h);
  });

  it("retains legacy native steering and its exact acknowledged prefix", async () => {
    const h = harness();
    await Effect.runPromise(h.process(h.event));
    expect(h.steerTurn).toHaveBeenCalledExactlyOnceWith({
      threadId,
      turnId,
      sessionEpoch: 1,
      input: "Additional instructions:\n- one",
    });
    expect(h.interruptTurn).not.toHaveBeenCalled();
    expect(
      h.dispatch.mock.calls.some(
        ([c]) =>
          c.type === "thread.queued-prompt.flush" && c.consumeOnly && c.messageIds.length === 1,
      ),
    ).toBe(true);
  });

  it("does not redeliver an ambiguously reserved operation", async () => {
    const h = harness({
      pendingTurnControlOperation: operation({ state: "ambiguous", strategy: "native-steer" }),
    });
    await Effect.runPromise(h.process(h.event));
    expect(h.steerTurn).not.toHaveBeenCalled();
    expect(h.interruptTurn).not.toHaveBeenCalled();
  });

  it("does not deliver a shortened reserved prefix", async () => {
    const h = harness({ queuedPrompts: [] });
    await Effect.runPromise(h.process(h.event));
    expect(h.steerTurn).not.toHaveBeenCalled();
    expect(h.interruptTurn).not.toHaveBeenCalled();
  });

  it("preserves ambiguity after failed native delivery without consuming", async () => {
    const h = harness();
    h.steerTurn.mockImplementation(() => Effect.die("lost acknowledgement"));
    await Effect.runPromise(h.process(h.event));
    expect(h.dispatch.mock.calls.some(([c]) => c.type === "thread.queued-prompt.flush")).toBe(
      false,
    );
    expect(h.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
      operation: { state: "ambiguous", deliveryAmbiguous: true },
    });
  });
});
