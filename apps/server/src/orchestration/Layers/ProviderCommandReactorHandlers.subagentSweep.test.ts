import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationTask,
  type OrchestrationThread,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

import type { ProviderThreadSubagentRef } from "../../provider/Services/ProviderAdapter.ts";
import type { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { subagentTask } from "../SubagentStopSweep.test.helpers.ts";
import {
  makeSweepSubagentsAfterInterrupt,
  withSubagentSweepAfterInterrupt,
} from "./ProviderCommandReactorHandlers.subagentSweep.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const turnId = TurnId.makeUnsafe("turn-1");
const REQUESTED_AT = "2026-10-21T10:00:00.000Z";

const threadWith = (input: {
  readonly tasks: ReadonlyArray<OrchestrationTask>;
  readonly activeTurnId?: TurnId | null;
  readonly providerName?: string;
}) =>
  ({
    id: threadId,
    tasks: input.tasks,
    session: {
      threadId,
      status: input.activeTurnId ? "running" : "ready",
      providerName: input.providerName ?? "codex",
      activeTurnId: input.activeTurnId ?? null,
    },
  }) as unknown as OrchestrationThread;

const harness = (initial: OrchestrationThread) =>
  Effect.gen(function* () {
    const thread = yield* Ref.make(initial);
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const stopped = yield* Ref.make<ReadonlyArray<ProviderThreadSubagentRef>>([]);
    const resolveThread = () => Ref.get(thread);
    const sweep = makeSweepSubagentsAfterInterrupt({
      orchestrationEngine: {
        dispatch: (command: OrchestrationCommand) =>
          Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 })),
      } as unknown as OrchestrationEngineShape,
      providerService: {
        stopThreadSubagents: (input: {
          readonly subagents: ReadonlyArray<ProviderThreadSubagentRef>;
        }) => Ref.update(stopped, (all) => [...all, ...input.subagents]),
      } as unknown as typeof ProviderService.Service,
      resolveThread,
    });
    return { thread, dispatched, stopped, resolveThread, sweep };
  });

const stoppedIds = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.task.upsert" && command.task.status === "stopped"
      ? [command.task.id]
      : [],
  );

it.effect("marks subagents still running after the grace period as stopped", () =>
  Effect.gen(function* () {
    const { thread, dispatched, sweep } = yield* harness(
      threadWith({
        tasks: [subagentTask("a"), subagentTask("b", { background: true }), subagentTask("c")],
        activeTurnId: turnId,
      }),
    );
    const fiber = yield* Effect.forkChild(
      sweep({ threadId, interruptedTurnId: turnId, requestedAt: REQUESTED_AT }),
    );
    yield* Effect.yieldNow;
    // The turn settles and the provider reports its own outcome for `c` in the grace period.
    yield* Ref.set(
      thread,
      threadWith({
        tasks: [
          subagentTask("a"),
          subagentTask("b", { background: true }),
          subagentTask("c", { status: "failed" }),
          subagentTask("new", { createdAt: "2026-10-21T10:00:01.000Z" }),
        ],
      }),
    );
    yield* TestClock.adjust("2999 millis");
    assert.deepEqual(yield* Ref.get(dispatched), []);
    yield* TestClock.adjust("1 millis");
    yield* Fiber.join(fiber);
    assert.deepEqual(stoppedIds(yield* Ref.get(dispatched)), ["a", "b"]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("waits for the stopped turn to settle and gives up if it never does", () =>
  Effect.gen(function* () {
    const { thread, dispatched, sweep } = yield* harness(
      threadWith({ tasks: [subagentTask("a")], activeTurnId: turnId }),
    );
    const settles = yield* Effect.forkChild(
      sweep({ threadId, interruptedTurnId: turnId, requestedAt: REQUESTED_AT }),
    );
    yield* TestClock.adjust("6 seconds");
    assert.deepEqual(yield* Ref.get(dispatched), []);
    yield* Ref.set(thread, threadWith({ tasks: [subagentTask("a")] }));
    yield* TestClock.adjust("3 seconds");
    yield* Fiber.join(settles);
    assert.deepEqual(stoppedIds(yield* Ref.get(dispatched)), ["a"]);

    yield* Ref.set(dispatched, []);
    yield* Ref.set(thread, threadWith({ tasks: [subagentTask("a")], activeTurnId: turnId }));
    const neverSettles = yield* Effect.forkChild(
      sweep({ threadId, interruptedTurnId: turnId, requestedAt: REQUESTED_AT }),
    );
    yield* TestClock.adjust("15 seconds");
    yield* Fiber.join(neverSettles);
    assert.deepEqual(yield* Ref.get(dispatched), []);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("asks the provider to stop every running subagent, flagging background ones", () =>
  Effect.gen(function* () {
    const tasks = [
      subagentTask("a"),
      subagentTask("b", { background: true }),
      subagentTask("done", { status: "completed" }),
    ];
    const { stopped, dispatched, sweep } = yield* harness(threadWith({ tasks }));
    const fiber = yield* Effect.forkChild(
      sweep({ threadId, interruptedTurnId: null, requestedAt: REQUESTED_AT }),
    );
    yield* TestClock.adjust("3 seconds");
    yield* Fiber.join(fiber);
    assert.deepEqual(yield* Ref.get(stopped), [
      { nativeId: "native-a", background: false },
      { nativeId: "native-b", background: true },
    ]);
    assert.deepEqual(stoppedIds(yield* Ref.get(dispatched)), ["a", "b"]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("sweeps after an acknowledged Stop, or an idle Stop even when unacknowledged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const swept = yield* Ref.make<ReadonlyArray<TurnId | null>>([]);
      const run = (input: { acknowledged: boolean; activeTurnId: TurnId | null }) =>
        withSubagentSweepAfterInterrupt({
          resolveThread: () =>
            Effect.succeed(
              threadWith({ tasks: [subagentTask("a")], activeTurnId: input.activeTurnId }),
            ),
          sweep: ((sweepInput: { readonly interruptedTurnId: TurnId | null }) =>
            Ref.update(swept, (all) => [...all, sweepInput.interruptedTurnId])) as never,
          processTurnInterruptRequested: () => Effect.succeed(input.acknowledged),
        })({
          type: "thread.turn-interrupt-requested",
          payload: { threadId, createdAt: REQUESTED_AT },
          commandId: CommandId.makeUnsafe("interrupt"),
        } as unknown as Extract<OrchestrationEvent, { type: "thread.turn-interrupt-requested" }>);

      yield* run({ acknowledged: false, activeTurnId: turnId });
      yield* run({ acknowledged: true, activeTurnId: turnId });
      yield* run({ acknowledged: false, activeTurnId: null });
      yield* Effect.yieldNow;
      assert.deepEqual(yield* Ref.get(swept), [turnId, null]);
    }),
  ),
);
