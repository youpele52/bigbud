import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, References, Tracer } from "effect";

import type { EffectTraceRecord } from "./TraceRecord.ts";
import { makeLocalFileTracer } from "./LocalFileTracer.ts";
import type { TracePolicy } from "./TracePolicy.ts";

const makeTestLayer = (tracePath: string) =>
  Layer.mergeAll(
    Layer.effect(
      Tracer.Tracer,
      makeLocalFileTracer({
        filePath: tracePath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        batchWindowMs: 10_000,
      }),
    ),
    Logger.layer([Logger.tracerLogger], { mergeWithExisting: false }),
    Layer.succeed(References.MinimumLogLevel, "Info"),
  );

const makePolicyLayer = (tracePath: string, tracePolicy: TracePolicy) =>
  Layer.effect(
    Tracer.Tracer,
    makeLocalFileTracer({
      filePath: tracePath,
      maxBytes: 1024 * 1024,
      maxFiles: 2,
      batchWindowMs: 10_000,
      tracePolicy,
    }),
  );

const readTraceRecords = (tracePath: string): Array<EffectTraceRecord> =>
  fs
    .readFileSync(tracePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EffectTraceRecord);

describe("LocalFileTracer", () => {
  it.effect("writes nested spans to disk and captures log messages as span events", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({
                "demo.parent": true,
              });
              yield* Effect.logInfo("parent event");
              yield* Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({
                  "demo.child": true,
                });
                yield* Effect.logInfo("child event");
              }).pipe(Effect.withSpan("child-span"));
            }).pipe(Effect.withSpan("parent-span"));

            yield* program.pipe(Effect.provide(makeTestLayer(tracePath)));
          }),
        );

        const records = readTraceRecords(tracePath);
        assert.equal(records.length, 2);

        const parent = records.find((record) => record.name === "parent-span");
        const child = records.find((record) => record.name === "child-span");

        assert.notEqual(parent, undefined);
        assert.notEqual(child, undefined);
        if (!parent || !child) {
          return;
        }

        assert.equal(child.parentSpanId, parent.spanId);
        assert.equal(parent.attributes["demo.parent"], true);
        assert.equal(child.attributes["demo.child"], true);
        assert.equal(
          parent.events.some((event) => event.name === "parent event"),
          true,
        );
        assert.equal(
          child.events.some((event) => event.name === "child event"),
          true,
        );
        assert.equal(
          child.events.some((event) => event.attributes["effect.logLevel"] === "INFO"),
          true,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("serializes interrupted spans with an interrupted exit status", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.exit(
            Effect.interrupt.pipe(
              Effect.withSpan("interrupt-span"),
              Effect.provide(makeTestLayer(tracePath)),
            ),
          ),
        );

        const records = readTraceRecords(tracePath);
        assert.equal(records.length, 1);
        assert.equal(records[0]?.name, "interrupt-span");
        assert.equal(records[0]?.exit._tag, "Interrupted");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("drops fast successful spans while retaining failures", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-local-tracer-policy-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.exit(
            Effect.gen(function* () {
              yield* Effect.succeed("fast").pipe(Effect.withSpan("fast-span"));
              return yield* Effect.fail("expected failure").pipe(Effect.withSpan("failure-span"));
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  makePolicyLayer(tracePath, {
                    mode: "production",
                    successSampleRate: 0,
                    slowSpanMs: Number.MAX_SAFE_INTEGER,
                    slowSqlSpanMs: Number.MAX_SAFE_INTEGER,
                  }),
                  Logger.layer([Logger.tracerLogger], { mergeWithExisting: false }),
                ),
              ),
            ),
          ),
        );

        const records = readTraceRecords(tracePath);
        assert.equal(
          records.some((record) => record.name === "fast-span"),
          false,
        );
        assert.equal(
          records.some((record) => record.name === "failure-span"),
          true,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("retains slow SQL spans in production mode", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-local-tracer-policy-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.succeed("slow").pipe(
            Effect.withSpan("sql.execute"),
            Effect.provide(
              makePolicyLayer(tracePath, {
                mode: "production",
                successSampleRate: 0,
                slowSpanMs: Number.MAX_SAFE_INTEGER,
                slowSqlSpanMs: 0,
              }),
            ),
          ),
        );

        const records = readTraceRecords(tracePath);
        assert.equal(
          records.some((record) => record.name === "sql.execute"),
          true,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
