import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, PubSub, Stream } from "effect";

import type { PromptSuggestionGenerationInput } from "../../git/Services/TextGeneration.ts";
import { startPromptSuggestionReactor } from "./PromptSuggestionReactor.ts";

const THREAD = ThreadId.makeUnsafe("thread-1");
const TURN = TurnId.makeUnsafe("turn-2");
const at = (second: number) => `2026-10-16T10:00:${String(second).padStart(2, "0")}.000Z`;
const message = (id: string, role: "user" | "assistant", text: string, second: number) => ({
  id: MessageId.makeUnsafe(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: at(second),
  updatedAt: at(second),
});

const settledThread = (provider: "codex" | "claudeAgent" | "opencodeV2") =>
  ({
    id: THREAD,
    interactionMode: "default",
    modelSelection: { provider, model: `${provider}-model` },
    latestTurn: {
      turnId: TURN,
      state: "completed",
      requestedAt: at(3),
      startedAt: at(3),
      completedAt: at(9),
      assistantMessageId: null,
    },
    session: { status: "ready", activeTurnId: null },
    queuedPrompts: [],
    archivedAt: null,
    deletingAt: null,
    deletedAt: null,
    activities: [],
    messages: [
      message("u1", "user", "Split the parser", 1),
      message("a1", "assistant", "Split into two modules.", 2),
      message("u2", "user", "Now add a lexer", 3),
      message("a2", "assistant", "Added the lexer.", 8),
    ],
  }) as unknown as OrchestrationThread;

const turnCompleted = {
  type: "turn.completed",
  eventId: "evt-done",
  provider: "codex",
  createdAt: at(9),
  threadId: THREAD,
  turnId: TURN,
  payload: { state: "completed" },
} as unknown as ProviderRuntimeEvent;

/** Starts the reactor over fakes; `generate` decides what text generation does. */
const setup = (
  provider: "codex" | "claudeAgent" | "opencodeV2",
  generate: (input: PromptSuggestionGenerationInput) => Effect.Effect<{ suggestion: string }>,
) =>
  Effect.gen(function* () {
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const dispatched: Array<unknown> = [];
    const requests: Array<PromptSuggestionGenerationInput> = [];
    yield* startPromptSuggestionReactor({
      orchestrationEngine: {
        getReadModel: () =>
          Effect.succeed({ threads: [settledThread(provider)], projects: [] } as never),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1 } as never;
          }),
        streamDomainEvents: Stream.fromPubSub(domainEvents),
      },
      providerEvents: Stream.fromPubSub(providerEvents),
      getCapabilities: (kind) =>
        Effect.succeed({
          sessionModelSwitch: "in-session",
          ...(kind === "claudeAgent" ? { nativePromptSuggestions: true } : {}),
        }),
      textGeneration: {
        generatePromptSuggestion: (input) =>
          Effect.suspend(() => {
            requests.push(input);
            return generate(input);
          }),
      },
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: { provider: "codex", model: "text-gen-model" },
      }),
      resolveCwd: () => Effect.succeed("/tmp"),
    });
    yield* Effect.yieldNow;
    return { providerEvents, domainEvents, dispatched, requests };
  });

const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

describe("PromptSuggestionReactor", () => {
  it.effect("attaches a generated suggestion using the explicit preference first", () =>
    Effect.gen(function* () {
      const harness = yield* setup("codex", () =>
        Effect.succeed({ suggestion: "Add tests for the new lexer" }),
      );
      yield* PubSub.publish(harness.providerEvents, turnCompleted);
      yield* settle;
      assert.equal(harness.requests[0]?.modelSelection.model, "text-gen-model");
      assert.include(harness.requests[0]?.transcript ?? "", "Now add a lexer");
      assert.equal(harness.dispatched.length, 1);
      assert.deepInclude(harness.dispatched[0] as object, { type: "thread.activity.append" });
      const activity = (harness.dispatched[0] as { activity: { payload: unknown; turnId: string } })
        .activity;
      assert.deepEqual(activity.payload, {
        suggestion: "Add tests for the new lexer",
        source: "generated",
        provider: "codex",
      });
      assert.equal(activity.turnId, TURN);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves the explicit preference even for a different thread provider", () =>
    Effect.gen(function* () {
      const harness = yield* setup("opencodeV2", () =>
        Effect.succeed({ suggestion: "Add tests for the new lexer" }),
      );
      yield* PubSub.publish(harness.providerEvents, turnCompleted);
      yield* settle;
      assert.deepEqual(harness.requests[0]?.modelSelection, {
        provider: "codex",
        model: "text-gen-model",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("never generates for a provider with native suggestions", () =>
    Effect.gen(function* () {
      const harness = yield* setup("claudeAgent", () =>
        Effect.succeed({ suggestion: "Add tests for the new lexer" }),
      );
      yield* PubSub.publish(harness.providerEvents, turnCompleted);
      yield* settle;
      assert.equal(harness.requests.length, 0);
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels an in-flight generation when the user sends a message", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>();
      const harness = yield* setup("codex", () =>
        Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      );
      yield* PubSub.publish(harness.providerEvents, turnCompleted);
      yield* settle;
      assert.equal(harness.requests.length, 1);
      yield* PubSub.publish(harness.domainEvents, {
        type: "thread.message-sent",
        payload: { threadId: THREAD, role: "user" },
      } as unknown as OrchestrationEvent);
      yield* Deferred.await(interrupted);
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.scoped),
  );
});
