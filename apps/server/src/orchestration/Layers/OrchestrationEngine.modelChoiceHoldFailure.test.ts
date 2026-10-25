import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { startDelegatedFirstTurn } from "../../orchestration-tools/ThreadOrchestrationTools.createThread.modelChoice.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  childId,
  heldMessageId,
  now,
  requestedPayload,
} from "../deciderThreads.delegationModelChoice.test.helpers.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

/**
 * The hold's dispatch reports a failure. "committed": it ran anyway (an interrupt or an admission
 * timeout); "rejected": it never ran.
 */
function failingHoldEngine(
  engine: OrchestrationEngineShape,
  mode: "committed" | "rejected",
): OrchestrationEngineShape {
  const failure = Effect.fail(new Error("admission deadline exceeded") as never);
  return {
    ...engine,
    dispatch: (command: OrchestrationCommand) =>
      command.type !== "thread.delegation.model-choice.hold"
        ? engine.dispatch(command)
        : mode === "committed"
          ? engine.dispatch(command).pipe(Effect.andThen(failure))
          : failure,
  };
}

describe("delegated model choice after an ambiguous hold failure (review fix #2)", () => {
  it.each(["committed", "rejected"] as const)(
    "sends the delegated message exactly once when the hold %s, even on retry",
    (mode) =>
      withDatabase("bigbud-model-choice-hold-failure-", async (dbPath) => {
        const runtime = createRuntime(dbPath);
        const engine = await engineFor(runtime);
        for (const command of createCommands(ProjectId.makeUnsafe("project-hold-failure"), [
          childId,
        ])) {
          await runtime.runPromise(engine.dispatch(command));
        }
        const start = () =>
          startDelegatedFirstTurn({
            orchestrationEngine: failingHoldEngine(engine, mode),
            decision: { kind: "hold", requested: requestedPayload, suggestions: [] },
            identity: "hold-failure",
            childThreadId: childId,
            createdAt: now,
            callerThread: {
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            },
            prompt: { messageId: heldMessageId, text: "Delegated task" },
          });
        await runtime.runPromise(start());
        // A create_thread retry repeats the same deterministic commands.
        await runtime.runPromise(start());

        const events = await runtime.runPromise(
          Stream.runCollect(engine.readEvents(0)).pipe(
            Effect.map((chunk) => Array.from(chunk) as OrchestrationEvent[]),
          ),
        );
        const sent = events.filter(
          (event) =>
            event.type === "thread.message-sent" && event.payload.messageId === heldMessageId,
        );
        expect(sent).toHaveLength(1);
        const readModel = await runtime.runPromise(engine.getReadModel());
        const child = readModel.threads.find((thread) => thread.id === childId);
        expect(child?.queuedPrompts?.map((prompt) => prompt.id) ?? []).not.toContain(heldMessageId);
        expect(
          child?.activities.filter(
            (activity) => activity.kind === "delegation.model-choice-resolved",
          ),
        ).toHaveLength(1);
        await runtime.dispose();
      }),
  );
});
