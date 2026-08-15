import { CommandId, MessageId, TurnId } from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import type { OrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import { seedProjectAndThread, THREAD_ID } from "./orchestrationEngine.integration.shared.ts";

const withPeriodicHarness = <A, E>(
  use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ testClock: true }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));

const nowIso = () => new Date().toISOString();

const seedRunningThread = (harness: OrchestrationIntegrationHarness, turnId: TurnId) =>
  Effect.gen(function* () {
    yield* seedProjectAndThread(harness);
    const createdAt = nowIso();
    yield* harness.providerService.startSession(THREAD_ID, {
      threadId: THREAD_ID,
      provider: "codex",
      cwd: harness.workspaceDir,
      runtimeMode: "approval-required",
    });
    yield* harness.adapterHarness!.setSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: THREAD_ID,
      activeTurnId: turnId,
      createdAt,
      updatedAt: createdAt,
    });
    yield* harness.engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(`seed-running-${turnId}`),
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: turnId,
        reason: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
  });

const queuePrompt = (harness: OrchestrationIntegrationHarness, id: string, text: string) =>
  harness.engine.dispatch({
    type: "thread.message.submit",
    commandId: CommandId.makeUnsafe(`queue-${id}`),
    threadId: THREAD_ID,
    message: { messageId: MessageId.makeUnsafe(id), text },
    delivery: "queue",
    createdAt: nowIso(),
  });

it.live("repairs a lost terminal state without user action", () =>
  withPeriodicHarness((harness) =>
    Effect.gen(function* () {
      yield* seedRunningThread(harness, TurnId.makeUnsafe("lost-terminal"));
      const readyAt = nowIso();
      yield* harness.adapterHarness!.setSession({
        provider: "codex",
        status: "ready",
        runtimeMode: "approval-required",
        threadId: THREAD_ID,
        createdAt: readyAt,
        updatedAt: readyAt,
      });

      yield* harness.advanceClock("5 seconds");
      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.session?.status === "ready" && entry.session.activeTurnId === null,
      );
      assert.equal(thread.session?.status, "ready");
    }),
  ),
);

it.live("waits one pass before settling a missing session", () =>
  withPeriodicHarness((harness) =>
    Effect.gen(function* () {
      yield* seedRunningThread(harness, TurnId.makeUnsafe("missing-grace"));
      yield* harness.adapterHarness!.removeSession(THREAD_ID);

      yield* harness.advanceClock("5 seconds");
      let thread = (yield* harness.engine.getReadModel()).threads.find(
        (entry) => entry.id === THREAD_ID,
      );
      assert.equal(thread?.session?.status, "running");

      yield* harness.advanceClock("5 seconds");
      thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.session?.status === "stopped" && entry.session.activeTurnId === null,
      );
      assert.equal(thread.session?.status, "stopped");
    }),
  ),
);

it.live("preserves an interrupt flush intent when a newer turn reappears during grace", () =>
  withPeriodicHarness((harness) =>
    Effect.gen(function* () {
      const oldTurnId = TurnId.makeUnsafe("old-turn");
      const newTurnId = TurnId.makeUnsafe("new-turn");
      yield* seedRunningThread(harness, oldTurnId);
      yield* queuePrompt(harness, "queued-a", "A");
      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("interrupt-a"),
        threadId: THREAD_ID,
        turnId: oldTurnId,
        queuedPromptIdsAfterSettlement: [MessageId.makeUnsafe("queued-a")],
        createdAt: nowIso(),
      });
      yield* harness.adapterHarness!.removeSession(THREAD_ID);
      yield* harness.advanceClock("5 seconds");

      const runningAt = nowIso();
      yield* harness.adapterHarness!.setSession({
        provider: "codex",
        status: "running",
        runtimeMode: "approval-required",
        threadId: THREAD_ID,
        activeTurnId: newTurnId,
        createdAt: runningAt,
        updatedAt: runningAt,
      });
      assert.equal((yield* harness.providerService.listSessions())[0]?.activeTurnId, newTurnId);

      const thread = (yield* harness.engine.getReadModel()).threads.find(
        (entry) => entry.id === THREAD_ID,
      )!;
      assert.deepEqual(
        (thread.queuedPrompts ?? []).map((prompt) => prompt.id),
        ["queued-a"],
      );
      assert.equal(thread.pendingInterruptFlushIntent?.requestedTurnId, oldTurnId);
      assert.deepEqual(harness.adapterHarness!.getSentTurnInputs(), []);
    }),
  ),
);

it.live("leaves state unchanged after one listSessions failure and repairs on the next pass", () =>
  withPeriodicHarness((harness) =>
    Effect.gen(function* () {
      yield* seedRunningThread(harness, TurnId.makeUnsafe("list-failure"));
      const readyAt = nowIso();
      yield* harness.adapterHarness!.setSession({
        provider: "codex",
        status: "ready",
        runtimeMode: "approval-required",
        threadId: THREAD_ID,
        createdAt: readyAt,
        updatedAt: readyAt,
      });
      yield* harness.adapterHarness!.failNextListSessions();

      yield* harness.advanceClock("5 seconds");
      let thread = (yield* harness.engine.getReadModel()).threads.find(
        (entry) => entry.id === THREAD_ID,
      );
      assert.equal(thread?.session?.status, "running");

      yield* harness.advanceClock("5 seconds");
      thread = yield* harness.waitForThread(
        THREAD_ID,
        (entry) => entry.session?.status === "ready" && entry.session.activeTurnId === null,
      );
      assert.equal(thread.session?.status, "ready");
    }),
  ),
);

it.live("leaves state unchanged when provider session listing times out", () =>
  withPeriodicHarness((harness) =>
    Effect.gen(function* () {
      yield* seedRunningThread(harness, TurnId.makeUnsafe("list-timeout"));
      const readyAt = nowIso();
      yield* harness.adapterHarness!.setSession({
        provider: "codex",
        status: "ready",
        runtimeMode: "approval-required",
        threadId: THREAD_ID,
        createdAt: readyAt,
        updatedAt: readyAt,
      });
      yield* harness.adapterHarness!.hangNextListSessions();

      yield* harness.advanceClock("5 seconds");
      const thread = (yield* harness.engine.getReadModel()).threads.find(
        (entry) => entry.id === THREAD_ID,
      );
      assert.equal(thread?.session?.status, "running");
      assert.equal(thread?.session?.activeTurnId, "list-timeout");
    }),
  ),
);

it.live("flushes only the prompts captured before interruption after periodic repair", () =>
  withPeriodicHarness((harness) =>
    Effect.gen(function* () {
      const turnId = TurnId.makeUnsafe("flush-captured");
      yield* seedRunningThread(harness, turnId);
      yield* queuePrompt(harness, "queued-a", "A");
      yield* queuePrompt(harness, "queued-b", "B");
      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("interrupt-ab"),
        threadId: THREAD_ID,
        turnId,
        queuedPromptIdsAfterSettlement: [
          MessageId.makeUnsafe("queued-a"),
          MessageId.makeUnsafe("queued-b"),
        ],
        createdAt: nowIso(),
      });
      yield* queuePrompt(harness, "queued-c", "C");
      yield* harness.adapterHarness!.removeSession(THREAD_ID);
      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [],
        deferCompletion: true,
      });

      yield* harness.advanceClock("5 seconds");
      yield* harness.advanceClock("5 seconds");
      yield* harness.advanceClock("5 seconds");
      yield* Effect.sleep("20 millis");
      const thread = (yield* harness.engine.getReadModel()).threads.find(
        (entry) => entry.id === THREAD_ID,
      )!;
      assert.deepEqual(
        (thread.queuedPrompts ?? []).map((prompt) => prompt.id),
        ["queued-c"],
      );
    }),
  ),
);
