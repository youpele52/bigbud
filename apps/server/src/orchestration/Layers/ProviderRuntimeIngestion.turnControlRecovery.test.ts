import {
  type OrchestrationCommand,
  type OrchestrationThread,
  type ProviderSession,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { model, now, operation, prompt, thread } from "../QueuedPromptPolicy.test.helpers.ts";
import { recoverTurnControlOperations } from "./ProviderRuntimeIngestion.turnControlRecovery.ts";

async function recover(
  value: OrchestrationThread,
  liveSessions: ReadonlyArray<ProviderSession> = [],
) {
  const dispatch = vi.fn((_command: OrchestrationCommand) => Effect.succeed({}));
  await Effect.runPromise(
    recoverTurnControlOperations({
      orchestrationEngine: {
        dispatch,
        getReadModel: () => Effect.succeed(model(value)),
      } as unknown as OrchestrationEngineShape,
      readModel: model(value),
      liveSessions,
      occurredAt: now,
    }),
  );
  return dispatch.mock.calls.map(([command]) => command);
}
const settled = () =>
  thread({ session: { ...thread().session!, status: "ready", activeTurnId: null } });

describe("turn control recovery prefix safety", () => {
  it("does not consume or release an ambiguous native reservation", async () => {
    expect(
      await recover(
        thread({
          ...settled(),
          pendingTurnControlOperation: operation({ strategy: "native-steer", state: "ambiguous" }),
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    {
      queuedPrompts: [prompt("one")],
      pendingTurnControlOperation: operation({
        strategy: "interrupt-continue",
        state: "waiting-for-settlement",
        reservedPromptIds: [prompt("one").id, prompt("two").id],
      }),
    },
    {
      queuedPrompts: [{ ...prompt("one"), runtimeMode: "full-access" as const }, prompt("two")],
      pendingTurnControlOperation: operation({
        strategy: "interrupt-continue",
        state: "waiting-for-settlement",
        reservedPromptIds: [prompt("one").id, prompt("two").id],
      }),
    },
    {
      queueHold: true,
      pendingTurnControlOperation: operation({ strategy: "native-steer", state: "ambiguous" }),
    },
    { archivedAt: now },
  ])("does not release invalid/unavailable reservations %#", async (overrides) => {
    expect(
      await recover(
        thread({
          ...settled(),
          pendingTurnControlOperation: operation({
            strategy: "interrupt-continue",
            state: "waiting-for-settlement",
          }),
          ...overrides,
        }),
      ),
    ).toEqual([]);
  });

  it("cannot interpret a newer active runtime turn as settlement", async () => {
    const value = thread({
      ...settled(),
      pendingTurnControlOperation: operation({
        strategy: "interrupt-continue",
        state: "waiting-for-settlement",
      }),
    });
    expect(
      await recover(value, [
        {
          threadId: value.id,
          sessionEpoch: 2,
          activeTurnId: "new-turn",
          status: "running",
        } as ProviderSession,
      ]),
    ).toEqual([]);
  });

  it.each(["native-steer", "interrupt-continue"] as const)(
    "completes %s after a persisted flush lost its completion event",
    async (strategy) => {
      const value = thread({
        queuedPrompts: [prompt("two")],
        pendingTurnControlOperation: operation({
          strategy,
          state: strategy === "native-steer" ? "provider-acknowledged" : "waiting-for-settlement",
        }),
      });
      const commands = await recover(value);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.turn-control.set",
        operation: { state: "completed" },
      });
    },
  );

  it("flushes settled captured options but does not complete a no-op dispatch", async () => {
    const value = thread({
      ...settled(),
      queuedPrompts: [{ ...prompt("one"), runtimeMode: "approval-required" }],
      pendingTurnControlOperation: operation({
        strategy: "interrupt-continue",
        state: "waiting-for-settlement",
      }),
    });
    const commands = await recover(value);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.queued-prompt.flush",
      messageIds: [prompt("one").id],
      controlOperationId: operation().operationId,
    });
  });
});
