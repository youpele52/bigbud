import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";

import type { MetadataTextGenerationAttempt } from "../Services/TextGeneration.ts";
import { runMetadataGenerationAttempt } from "./MetadataTextGeneration.ts";

const operation = "generateThreadTitle";
const valid = { title: "Repair durable metadata recovery" };
const fixture = (): MetadataTextGenerationAttempt => ({
  selection: { provider: "codex", model: "captured", options: { reasoningEffort: "high" } },
  executionTarget: "local",
  providerSettings: structuredClone(DEFAULT_SERVER_SETTINGS.providers),
  beforeDispatch: vi.fn(() => Effect.void),
});
const failure = (metadataOutcome?: TextGenerationError["metadataOutcome"]) =>
  new TextGenerationError({
    operation,
    detail: "secret provider output",
    cause: new Error("credential"),
    ...(metadataOutcome ? { metadataOutcome } : {}),
  });
const run = (
  attempt: MetadataTextGenerationAttempt,
  generate: (
    attempt: MetadataTextGenerationAttempt,
  ) => Effect.Effect<typeof valid, TextGenerationError>,
) => runMetadataGenerationAttempt({ operation, attempt, generate });
const errorOf = (effect: Effect.Effect<unknown, TextGenerationError>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => {
          throw new Error("Expected failure");
        },
      }),
    ),
  );

describe("one exact metadata generation attempt", () => {
  it("captures the full selection and settings and reports the actual model", async () => {
    const attempt = fixture();
    const original = structuredClone(attempt.selection);
    const generate = vi.fn((captured: MetadataTextGenerationAttempt) =>
      Effect.gen(function* () {
        expect(captured.selection).toEqual(original);
        expect(captured.providerSettings).toEqual(attempt.providerSettings);
        expect(captured.providerSettings).not.toBe(attempt.providerSettings);
        Object.assign(attempt.selection, { model: "mutated-after-capture" });
        yield* captured.beforeDispatch();
        return valid;
      }),
    );
    expect(await Effect.runPromise(run(attempt, generate))).toEqual({
      ...valid,
      actualModelSelection: original,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(attempt.beforeDispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["remote:workspace", "", "ssh"])(
    "rejects target %s before any runner",
    async (executionTarget) => {
      const attempt = { ...fixture(), executionTarget };
      const generate = vi.fn(() => Effect.succeed(valid));
      expect((await errorOf(run(attempt, generate))).metadataOutcome).toBe("unavailable");
      expect(generate).not.toHaveBeenCalled();
      expect(attempt.beforeDispatch).not.toHaveBeenCalled();
    },
  );

  it("fails closed for unsupported or disabled providers", async () => {
    const unsupported: MetadataTextGenerationAttempt = {
      ...fixture(),
      selection: { provider: "devin", model: "unqualified" },
    };
    const disabled = fixture();
    Object.assign(disabled.providerSettings.codex, { enabled: false });
    for (const attempt of [unsupported, disabled]) {
      const generate = vi.fn(() => Effect.succeed(valid));
      expect((await errorOf(run(attempt, generate))).metadataOutcome).toBe("unavailable");
      expect(generate).not.toHaveBeenCalled();
    }
  });

  it("requires a provider-owned fence before accepting a result", async () => {
    const attempt = fixture();
    expect((await errorOf(run(attempt, () => Effect.succeed(valid)))).metadataOutcome).toBe(
      "unavailable",
    );
    expect(attempt.beforeDispatch).not.toHaveBeenCalled();
  });

  it("does not retry or leak raw output on preflight failure", async () => {
    const generate = vi.fn(() => Effect.fail(failure("failed")));
    const attempt = fixture();
    const error = await errorOf(run(attempt, generate));
    expect(error.metadataOutcome).toBe("unavailable");
    expect(error.detail).not.toContain("secret");
    expect(error.cause).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(attempt.beforeDispatch).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "uncertain"],
    ["uncertain", "uncertain"],
    ["unavailable", "uncertain"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const)("classifies post-dispatch %s as %s", async (outcome, expected) => {
    const generate = vi.fn((attempt: MetadataTextGenerationAttempt) =>
      Effect.gen(function* () {
        yield* attempt.beforeDispatch();
        return yield* failure(outcome);
      }),
    );
    const error = await errorOf(run(fixture(), generate));
    expect(error.metadataOutcome).toBe(expected);
    expect(error.cause).toBeUndefined();
    expect(error.detail).not.toContain("secret");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("retains uncertainty when the durable claim response is lost", async () => {
    const attempt = { ...fixture(), beforeDispatch: () => Effect.fail(failure()) };
    const error = await errorOf(
      run(attempt, (captured) => captured.beforeDispatch().pipe(Effect.as(valid))),
    );
    expect(error.metadataOutcome).toBe("uncertain");
  });

  it("accepts an authoritative pre-dispatch refusal", async () => {
    const attempt = { ...fixture(), beforeDispatch: () => Effect.fail(failure("unavailable")) };
    const error = await errorOf(
      run(attempt, (captured) => captured.beforeDispatch().pipe(Effect.as(valid))),
    );
    expect(error.metadataOutcome).toBe("unavailable");
  });

  it.each(["", "New thread"])(
    "counts unusable completed title %s as one failure",
    async (title) => {
      const error = await errorOf(
        run(fixture(), (attempt) => attempt.beforeDispatch().pipe(Effect.as({ title }))),
      );
      expect(error.metadataOutcome).toBe("failed");
    },
  );

  it("counts empty completed summaries as definitive failure", async () => {
    const error = await errorOf(
      runMetadataGenerationAttempt({
        operation: "generateThreadElevatorSummary",
        attempt: fixture(),
        generate: (attempt) => attempt.beforeDispatch().pipe(Effect.as({ summary: "  " })),
      }),
    );
    expect(error.metadataOutcome).toBe("failed");
  });

  it("rejects duplicate sequential fence invocations", async () => {
    const attempt = fixture();
    const error = await errorOf(
      run(attempt, (captured) =>
        Effect.gen(function* () {
          yield* captured.beforeDispatch();
          yield* captured.beforeDispatch();
          return valid;
        }),
      ),
    );
    expect(error.metadataOutcome).toBe("uncertain");
    expect(attempt.beforeDispatch).toHaveBeenCalledTimes(1);
  });

  it("admits only one concurrent fence call even while the first is suspended", async () => {
    const beforeDispatch = vi.fn(() => Effect.yieldNow);
    await Effect.runPromise(
      run({ ...fixture(), beforeDispatch }, (captured) =>
        Effect.gen(function* () {
          const outcomes = yield* Effect.all(
            [
              captured.beforeDispatch().pipe(Effect.result),
              captured.beforeDispatch().pipe(Effect.result),
            ],
            { concurrency: 2 },
          );
          expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
          return valid;
        }),
      ),
    );
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
  });
});
