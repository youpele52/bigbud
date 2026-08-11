import type { ServerProvider } from "@bigbud/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, References, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeManagedServerProvider } from "./makeManagedServerProvider";

const BASE_SNAPSHOT = {
  provider: "opencode",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  models: [],
  slashCommands: [],
  skills: [],
} as const satisfies Omit<ServerProvider, "checkedAt">;

type DiagnosticFields = Readonly<Record<string, unknown>>;

function getDiagnostic(
  messages: ReadonlyArray<unknown>,
  name: string,
  predicate: (fields: DiagnosticFields) => boolean = () => true,
): DiagnosticFields | undefined {
  for (const message of messages) {
    const parts = Array.isArray(message) ? message : [message];
    const fields = parts[1];
    if (
      parts[0] === name &&
      typeof fields === "object" &&
      fields !== null &&
      predicate(fields as DiagnosticFields)
    ) {
      return fields as DiagnosticFields;
    }
  }
  return undefined;
}

const makeDiagnosticsLayer = (messages: Array<unknown>) =>
  Layer.mergeAll(
    Logger.layer(
      [
        Logger.make(({ message }) => {
          messages.push(message);
        }),
      ],
      { mergeWithExisting: false },
    ),
    Layer.succeed(References.MinimumLogLevel, "Debug"),
    TestClock.layer(),
  );

describe("makeManagedServerProvider diagnostics", () => {
  it.effect("records a safe structured startup retry and exhaustion lifecycle", () => {
    const messages: Array<unknown> = [];
    const failed = {
      ...BASE_SNAPSHOT,
      installed: false,
      status: "error" as const,
      failure: { classification: "retryable" as const, reason: "startup-timeout" as const },
      message: "PATH=/private/provider token=raw-token credential=raw-credential",
      checkedAt: "2026-08-11T12:00:00.000Z",
    };

    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* makeManagedServerProvider({
          getSettings: Effect.succeed({
            enabled: true,
            binaryPath: "/private/provider",
            token: "raw-token",
          }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          checkProvider: Effect.succeed(failed),
          initialSnapshot: failed,
          refreshInterval: "1 hour",
        });

        yield* Effect.yieldNow;
        for (const delay of ["1 second", "3 seconds", "8 seconds", "20 seconds"] as const) {
          yield* TestClock.adjust(delay);
          yield* Effect.yieldNow;
        }
        assert.strictEqual((yield* service.getSnapshot).recovery?.status, "exhausted");

        const started = getDiagnostic(messages, "provider recovery operation started");
        assert.strictEqual(started?.provider, "opencode");
        assert.strictEqual(started?.trigger, "startup");
        assert.strictEqual(started?.generation, 1);
        assert.strictEqual(started?.maxAttempts, 5);
        assert.isString(started?.operationId);
        const operationId = started!.operationId;
        assert.deepStrictEqual(
          getDiagnostic(
            messages,
            "provider probe attempt",
            (fields) => fields.trigger === "background" && fields.attempt === 5,
          ),
          { provider: "opencode", generation: 1, trigger: "background", attempt: 5 },
        );
        assert.deepStrictEqual(
          getDiagnostic(
            messages,
            "provider probe result",
            (fields) => fields.classification === "retryable",
          ),
          {
            provider: "opencode",
            generation: 1,
            classification: "retryable",
            reason: "startup-timeout",
          },
        );
        assert.deepStrictEqual(
          getDiagnostic(
            messages,
            "provider recovery retry scheduled",
            (fields) => fields.delay === "20 seconds",
          ),
          {
            provider: "opencode",
            trigger: "background",
            generation: 1,
            operationId,
            attempt: 5,
            delay: "20 seconds",
          },
        );
        assert.deepStrictEqual(getDiagnostic(messages, "provider recovery exhausted"), {
          provider: "opencode",
          trigger: "background",
          generation: 1,
          operationId,
          classification: "retryable",
          reason: "startup-timeout",
        });

        const serialized = JSON.stringify(messages);
        assert.notInclude(serialized, "/private/provider");
        assert.notInclude(serialized, "raw-token");
        assert.notInclude(serialized, "raw-credential");
        assert.notInclude(serialized, "PATH=");
      }),
    ).pipe(Effect.provide(makeDiagnosticsLayer(messages)));
  });

  it.effect("records recovery completion and pending-retry supersession", () => {
    const messages: Array<unknown> = [];

    return Effect.scoped(
      Effect.gen(function* () {
        const probes = yield* Ref.make(0);
        const failed = {
          ...BASE_SNAPSHOT,
          status: "error" as const,
          failure: { classification: "retryable" as const, reason: "connection-refused" as const },
          checkedAt: "2026-08-11T12:00:00.000Z",
        };
        const ready = { ...BASE_SNAPSHOT, checkedAt: "2026-08-11T12:00:01.000Z" };
        const service = yield* makeManagedServerProvider({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          checkProvider: Ref.updateAndGet(probes, (count) => count + 1).pipe(
            Effect.map((count) => (count === 1 ? failed : ready)),
          ),
          initialSnapshot: failed,
          refreshInterval: "1 hour",
        });

        yield* Effect.yieldNow;
        yield* service.refreshWithRecovery({ attempt: 1, maxAttempts: 3, trigger: "manual" });
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        const manualStarted = getDiagnostic(
          messages,
          "provider recovery operation started",
          (fields) => fields.trigger === "manual",
        );
        assert.strictEqual(manualStarted?.provider, "opencode");
        assert.strictEqual(manualStarted?.trigger, "manual");
        assert.strictEqual(manualStarted?.generation, 2);
        assert.strictEqual(manualStarted?.maxAttempts, 3);
        assert.isString(manualStarted?.operationId);
        const superseded = getDiagnostic(messages, "provider recovery superseded");
        assert.strictEqual(superseded?.provider, "opencode");
        assert.strictEqual(superseded?.trigger, "startup");
        assert.strictEqual(superseded?.generation, 1);
        assert.isString(superseded?.operationId);
        assert.strictEqual((yield* service.getSnapshot).status, "ready");
      }),
    ).pipe(Effect.provide(makeDiagnosticsLayer(messages)));
  });

  it.effect("records a recovered startup operation as completed", () => {
    const messages: Array<unknown> = [];

    return Effect.scoped(
      Effect.gen(function* () {
        const probes = yield* Ref.make(0);
        const failed = {
          ...BASE_SNAPSHOT,
          status: "error" as const,
          failure: { classification: "retryable" as const, reason: "process-failed" as const },
          checkedAt: "2026-08-11T12:00:00.000Z",
        };
        const ready = { ...BASE_SNAPSHOT, checkedAt: "2026-08-11T12:00:01.000Z" };
        const service = yield* makeManagedServerProvider({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          checkProvider: Ref.updateAndGet(probes, (count) => count + 1).pipe(
            Effect.map((count) => (count === 1 ? failed : ready)),
          ),
          initialSnapshot: failed,
          refreshInterval: "1 hour",
        });

        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Effect.yieldNow;

        const completed = getDiagnostic(messages, "provider recovery completed");
        assert.strictEqual(completed?.provider, "opencode");
        assert.strictEqual(completed?.trigger, "startup");
        assert.strictEqual(completed?.generation, 1);
        assert.strictEqual(completed?.outcome, "recovered");
        assert.isString(completed?.operationId);
        assert.strictEqual((yield* service.getSnapshot).status, "ready");
      }),
    ).pipe(Effect.provide(makeDiagnosticsLayer(messages)));
  });
});
