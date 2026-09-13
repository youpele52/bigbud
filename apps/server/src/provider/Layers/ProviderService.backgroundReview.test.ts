import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { assert } from "@effect/vitest";
import { Effect, Fiber, Option, Ref, Stream } from "effect";
import type { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  asEventId,
  asThreadId,
  asTurnId,
  makeProviderServiceLayer,
  sleep,
} from "./ProviderService.test.helpers.ts";

const harness = makeProviderServiceLayer({
  settings: {
    providers: {
      codex: { enabled: true },
      claudeAgent: { enabled: true },
      copilot: { enabled: true },
      cursor: { enabled: true },
      devin: { enabled: true },
      opencode: { enabled: true },
      kilocode: { enabled: true },
      pi: { enabled: true },
    },
  },
});
const ownerThreadId = asThreadId("review-owner");
const request = (provider: ProviderKind = "codex") => ({
  ownerThreadId,
  jobId: "review-job",
  modelSelection: { provider, model: "test-model" },
  cwd: process.cwd(),
  input: "Review evidence.",
});

harness.layer("background provider reviews", (it) => {
  for (const [providerKind, adapter] of [
    ["codex", harness.codex],
    ["claudeAgent", harness.claude],
    ["copilot", harness.copilot],
    ["cursor", harness.cursor],
    ["devin", harness.devin],
    ["opencode", harness.opencode],
    ["kilocode", harness.kilocode],
    ["pi", harness.pi],
  ] as const) {
    it.effect(
      `isolates ${providerKind} review sessions from migrated runtime bindings and events`,
      () =>
        Effect.gen(function* () {
          const provider = yield* ProviderService;
          const directory = yield* ProviderSessionDirectory;
          const received = yield* Ref.make(0);
          const consumer = yield* Stream.runForEach(provider.streamEvents, () =>
            Ref.update(received, (n) => n + 1),
          ).pipe(Effect.forkChild({ startImmediately: true }));
          adapter.sendTurn.mockImplementationOnce((turn) =>
            Effect.gen(function* () {
              assert.deepEqual(yield* provider.listSessions(), []);
              assert.deepEqual((yield* provider.listSessionsForReconciliation()).sessions, []);
              assert.isTrue(
                Option.isNone(yield* directory.getBinding(turn.threadId).pipe(Effect.orDie)),
              );
              adapter.emit({
                type: "content.delta",
                eventId: asEventId("review-text"),
                provider: providerKind,
                threadId: turn.threadId,
                createdAt: new Date().toISOString(),
                payload: { streamKind: "assistant_text", delta: "{}" },
              });
              adapter.emit({
                type: "turn.completed",
                eventId: asEventId("review-done"),
                provider: providerKind,
                threadId: turn.threadId,
                createdAt: new Date().toISOString(),
                payload: { state: "completed" },
              });
              return { threadId: turn.threadId, turnId: asTurnId("review-turn") };
            }),
          );
          assert.equal(yield* provider.runBackgroundReview(request(providerKind)), "{}");
          const start = adapter.startSession.mock.calls.at(-1)![0];
          assert.equal(start.approvalPolicy, "untrusted");
          assert.equal(start.sandboxMode, "read-only");
          assert.equal(start.runtimeMode, "approval-required");
          assert.notEqual(start.threadId, ownerThreadId);
          assert.isTrue(Option.isNone(yield* directory.getBinding(ownerThreadId)));
          assert.isFalse(yield* adapter.adapter.hasSession(start.threadId));
          adapter.emit({
            type: "turn.completed",
            eventId: asEventId("late-done"),
            provider: providerKind,
            threadId: start.threadId,
            createdAt: new Date().toISOString(),
            payload: { state: "completed" },
          });
          yield* sleep(10);
          assert.equal(yield* Ref.get(received), 0);
          yield* Fiber.interrupt(consumer);
        }),
    );
  }

  for (const event of [
    { type: "turn.completed", payload: { state: "failed" } },
    { type: "turn.aborted", payload: { reason: "cancelled" } },
    { type: "request.opened", payload: {} },
    { type: "user-input.requested", payload: {} },
    { type: "runtime.error", payload: {} },
    { type: "session.exited", payload: {} },
    { type: "content.delta", payload: { streamKind: "assistant_text", delta: "x".repeat(24_001) } },
  ]) {
    it.effect(`rejects ${event.type} and stops the private session`, () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        harness.codex.sendTurn.mockImplementationOnce((turn) =>
          Effect.sync(() => {
            harness.codex.emit({
              ...event,
              eventId: asEventId("failure"),
              provider: "codex",
              threadId: turn.threadId,
              createdAt: new Date().toISOString(),
            });
            return { threadId: turn.threadId, turnId: asTurnId("review-turn") };
          }),
        );
        const failure = yield* Effect.flip(provider.runBackgroundReview(request()));
        assert.equal(failure._tag, "ProviderValidationError");
        assert.deepEqual(yield* harness.codex.adapter.listSessions(), []);
      }),
    );
  }

  it.effect("preserves an existing canonical owner binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, scripts_json, created_at, updated_at)
      VALUES ('review-project', 'Project', '{}', datetime('now'), datetime('now'))`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${ownerThreadId}, 'review-project', 'Thread', '{"provider":"codex","model":"test"}', 'full-access', 'default', datetime('now'), datetime('now'))`;
      yield* provider.startSession(ownerThreadId, {
        threadId: ownerThreadId,
        provider: "codex",
        runtimeMode: "full-access",
      });
      const before = yield* directory.getBinding(ownerThreadId);
      harness.codex.sendTurn.mockImplementationOnce((turn) =>
        Effect.sync(() => {
          harness.codex.emit({
            type: "turn.completed",
            eventId: asEventId("owner-review"),
            provider: "codex",
            threadId: turn.threadId,
            createdAt: new Date().toISOString(),
            payload: { state: "completed" },
          });
          return { threadId: turn.threadId, turnId: asTurnId("review-turn") };
        }),
      );
      yield* provider.runBackgroundReview(request());
      assert.deepEqual(yield* directory.getBinding(ownerThreadId), before);
      assert.isTrue(yield* harness.codex.adapter.hasSession(ownerThreadId));
      yield* provider.stopSession({ threadId: ownerThreadId });
    }),
  );

  it.effect("rejects unsupported providers before startup", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const before = harness.cliProxy.startSession.mock.calls.length;
      const error = yield* Effect.flip(provider.runBackgroundReview(request("cliProxy")));
      assert.equal(error._tag, "ProviderValidationError");
      assert.equal(harness.cliProxy.startSession.mock.calls.length, before);
    }),
  );

  it.effect("reports cleanup failure instead of successful review text", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      harness.codex.sendTurn.mockImplementationOnce((turn) =>
        Effect.sync(() => {
          harness.codex.emit({
            type: "turn.completed",
            eventId: asEventId("cleanup-review"),
            provider: "codex",
            threadId: turn.threadId,
            createdAt: new Date().toISOString(),
            payload: { state: "completed" },
          });
          return { threadId: turn.threadId, turnId: asTurnId("review-turn") };
        }),
      );
      harness.codex.stopSession.mockImplementationOnce((threadId) =>
        Effect.fail(
          new ProviderAdapterProcessError({
            provider: "codex",
            threadId,
            detail: "cleanup failed",
          }),
        ),
      );
      const error = yield* Effect.flip(provider.runBackgroundReview(request()));
      assert.equal(error._tag, "ProviderValidationError");
      if (error._tag === "ProviderValidationError")
        assert.equal(error.operation, "ProviderService.runBackgroundReview.cleanup");
      const threadId = harness.codex.startSession.mock.calls.at(-1)![0].threadId;
      yield* harness.codex.adapter.stopSession(threadId);
    }),
  );

  it.effect("reports cleanup timeout and still excludes the abandoned session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      harness.codex.sendTurn.mockImplementationOnce((turn) =>
        Effect.sync(() => {
          harness.codex.emit({
            type: "turn.completed",
            eventId: asEventId("cleanup-timeout-review"),
            provider: "codex",
            threadId: turn.threadId,
            createdAt: new Date().toISOString(),
            payload: { state: "completed" },
          });
          return { threadId: turn.threadId, turnId: asTurnId("review-turn") };
        }),
      );
      harness.codex.stopSession.mockImplementationOnce(() => Effect.never);
      const fiber = yield* provider.runBackgroundReview(request()).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      const error = yield* Effect.flip(Fiber.join(fiber));
      assert.equal(error._tag, "ProviderValidationError");
      if (error._tag === "ProviderValidationError")
        assert.equal(error.operation, "ProviderService.runBackgroundReview.cleanup");
      assert.deepEqual(yield* provider.listSessions(), []);
      yield* harness.codex.adapter.stopSession(
        harness.codex.startSession.mock.calls.at(-1)![0].threadId,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("bounds startup and cleans up on timeout", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      harness.codex.startSession.mockImplementationOnce(() => Effect.never);
      const fiber = yield* provider.runBackgroundReview(request()).pipe(Effect.forkChild);
      yield* TestClock.adjust("3 minutes");
      const failure = yield* Effect.flip(Fiber.join(fiber));
      assert.equal(failure._tag, "ProviderValidationError");
      assert.equal(
        harness.codex.stopSession.mock.calls.at(-1)![0],
        harness.codex.startSession.mock.calls.at(-1)![0].threadId,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cleans up when the owner is interrupted", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const fiber = yield* provider.runBackgroundReview(request()).pipe(Effect.forkChild);
      yield* sleep(10);
      yield* Fiber.interrupt(fiber);
      assert.deepEqual(yield* harness.codex.adapter.listSessions(), []);
    }),
  );
});

for (const [name, options] of [
  ["disabled", { settings: { providers: { codex: { enabled: false } } } }],
  ["uncomposed", { isProviderComposed: () => false }],
] as const) {
  const gated = makeProviderServiceLayer(options);
  gated.layer(`background review ${name} gate`, (it) => {
    it.effect("rejects before starting the adapter", () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const before = gated.codex.startSession.mock.calls.length;
        const error = yield* Effect.flip(provider.runBackgroundReview(request()));
        assert.equal(error._tag, "ProviderValidationError");
        assert.equal(gated.codex.startSession.mock.calls.length, before);
      }),
    );
  });
}
