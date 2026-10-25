import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { TextGenerationError, type ModelSelection } from "@bigbud/contracts";
import {
  internalTextGenerationCandidates,
  runInternalTextGeneration,
} from "./InternalTextGenerationPolicy.ts";

const preference: ModelSelection = { provider: "codex", model: "explicit-model" };
const successful: ModelSelection = { provider: "claudeAgent", model: "successful-model" };
const failure = (detail = "Provider rejected the model") =>
  new TextGenerationError({ operation: "fixture", detail });

describe("internal text generation policy", () => {
  it.each(["invalid-input", "cancelled"] as const)(
    "honors typed %s failures without another provider call",
    async (kind) => {
      let calls = 0;
      await Effect.runPromise(
        runInternalTextGeneration({
          operation: "fixture",
          preference,
          successful,
          generate: () => {
            calls++;
            return Effect.fail(
              new TextGenerationError({ operation: "fixture", detail: "Request stopped", kind }),
            );
          },
        }).pipe(Effect.flip),
      );
      expect(calls).toBe(1);
    },
  );
  it("allows the successful pair to recover from an empty provider response", async () => {
    let calls = 0;
    const result = await Effect.runPromise(
      runInternalTextGeneration({
        operation: "fixture",
        preference,
        successful,
        generate: () =>
          ++calls === 1
            ? Effect.fail(failure("Provider returned empty output"))
            : Effect.succeed("Recovered"),
      }),
    );
    expect(result).toBe("Recovered");
    expect(calls).toBe(2);
  });
  it("orders the override before the actual successful thread pair", () => {
    expect(internalTextGenerationCandidates(preference, successful)).toEqual([
      preference,
      successful,
    ]);
  });
  it("has no global default for new threads or threadless jobs", () => {
    expect(internalTextGenerationCandidates(null, null)).toEqual([]);
    expect(internalTextGenerationCandidates(null, successful)).toEqual([successful]);
  });
  it("does not retry the same pair with different reasoning options", () => {
    expect(
      internalTextGenerationCandidates(preference, {
        ...preference,
        options: { reasoningEffort: "high" },
      }),
    ).toEqual([preference]);
  });
  it("retains distinct sub-provider identities", () => {
    const first: ModelSelection = { provider: "opencode", model: "same", subProviderID: "a" };
    const second: ModelSelection = { provider: "opencode", model: "same", subProviderID: "b" };
    expect(internalTextGenerationCandidates(first, second)).toEqual([first, second]);
  });
  it("succeeds on the preferred pair without a fallback call", async () => {
    const seen: ModelSelection[] = [];
    const result = await Effect.runPromise(
      runInternalTextGeneration({
        operation: "fixture",
        preference,
        successful,
        generate: (selection) => {
          seen.push(selection);
          return Effect.succeed("preferred");
        },
      }),
    );
    expect(result).toBe("preferred");
    expect(seen).toEqual([preference]);
  });
  it("falls through across providers once, with exact model identities", async () => {
    const seen: ModelSelection[] = [];
    const result = await Effect.runPromise(
      runInternalTextGeneration({
        operation: "fixture",
        preference,
        successful,
        generate: (selection) => {
          seen.push(selection);
          return selection === preference ? Effect.fail(failure()) : Effect.succeed("fallback");
        },
      }),
    );
    expect(result).toBe("fallback");
    expect(seen).toEqual([preference, successful]);
  });
  it("stops after both authorized pairs fail", async () => {
    const seen: ModelSelection[] = [];
    await Effect.runPromise(
      runInternalTextGeneration({
        operation: "fixture",
        preference,
        successful,
        generate: (selection) => {
          seen.push(selection);
          return Effect.fail(failure());
        },
      }).pipe(Effect.flip),
    );
    expect(seen).toEqual([preference, successful]);
  });
  it.each(["Invalid input", "Input must provide a transcript", "Empty message"])(
    "does not fall through for %s",
    async (detail) => {
      const seen: ModelSelection[] = [];
      await Effect.runPromise(
        runInternalTextGeneration({
          operation: "fixture",
          preference,
          successful,
          generate: (selection) => {
            seen.push(selection);
            return Effect.fail(failure(detail));
          },
        }).pipe(Effect.flip),
      );
      expect(seen).toEqual([preference]);
    },
  );
  it("never falls through an interruption", async () => {
    const seen: ModelSelection[] = [];
    const exit = await Effect.runPromiseExit(
      runInternalTextGeneration({
        operation: "fixture",
        preference,
        successful,
        generate: (selection) => {
          seen.push(selection);
          return Effect.interrupt;
        },
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(seen).toEqual([preference]);
  });
  it("fails without calling any provider when no pair is authorized", async () => {
    let calls = 0;
    const error = await Effect.runPromise(
      runInternalTextGeneration({
        operation: "fixture",
        preference: null,
        generate: () => {
          calls++;
          return Effect.succeed("unexpected");
        },
      }).pipe(Effect.flip),
    );
    expect(error.detail).toContain("No explicit");
    expect(calls).toBe(0);
  });
});
