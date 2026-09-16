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
import { makeProcessTurnSteerRequested } from "./ProviderCommandReactorHandlers.steer.ts";

function harness(overrides: Partial<OrchestrationThread> = {}) {
  const op = operation();
  const value = thread({ pendingTurnControlOperation: op, ...overrides });
  const dispatch = vi.fn((_command: OrchestrationCommand) => Effect.succeed({}));
  const steerTurn = vi.fn(() => Effect.void);
  const interruptTurn = vi.fn(() => Effect.void);
  const process = makeProcessTurnSteerRequested({
    providerService: {
      getCapabilities: () => Effect.succeed({ turnControl: { nativeSteer: true } }),
      steerTurn,
      interruptTurn,
    } as unknown as ProviderServiceShape,
    orchestrationEngine: {
      dispatch,
      getReadModel: () => Effect.succeed(model(value)),
    } as unknown as OrchestrationEngineShape,
    resolveThread: () => Effect.succeed(model(value)),
    appendProviderFailureActivity: () => Effect.void,
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
  return { process, event, dispatch, steerTurn, interruptTurn };
}

describe("metadata-aware queued steering", () => {
  it.each([
    { runtimeMode: "full-access" as const },
    { runtimeMode: "approval-required" as const },
    { interactionMode: "plan" as const },
    { modelSelection: { provider: "codex" as const, model: "different" } },
  ])(
    "uses settlement, never text-only native delivery, for explicit options %#",
    async (settings) => {
      const h = harness({ queuedPrompts: [{ ...prompt("one"), ...settings }, prompt("two")] });
      await Effect.runPromise(h.process(h.event));
      expect(h.steerTurn).not.toHaveBeenCalled();
      expect(h.interruptTurn).toHaveBeenCalledExactlyOnceWith({
        threadId,
        turnId,
        sessionEpoch: 1,
      });
      expect(h.dispatch.mock.calls.some(([c]) => c.type === "thread.queued-prompt.flush")).toBe(
        false,
      );
      expect(h.dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
        type: "thread.turn-control.set",
        operation: { state: "waiting-for-settlement", strategy: "interrupt-continue" },
      });
    },
  );

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
