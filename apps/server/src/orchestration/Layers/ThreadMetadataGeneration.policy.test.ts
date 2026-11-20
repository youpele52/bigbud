import { describe, expect, it } from "vitest";

import {
  metadataExecutionFingerprint,
  metadataWarningRequired,
  nextMetadataAction,
  type MetadataAttemptEvidence,
  type MetadataExecutionPath,
} from "./ThreadMetadataGeneration.policy.ts";

const failed = (
  stage: MetadataAttemptEvidence["stage"],
  executionFingerprint = "primary",
): MetadataAttemptEvidence => ({
  stage,
  executionFingerprint,
  state: "failed",
});
const base: Parameters<typeof nextMetadataAction>[0] = {
  state: "pending",
  attempts: [],
  now: 1,
  deadline: 100,
  modelWaitUntil: 5,
  primaryFingerprint: "primary",
  threadModelFingerprint: "thread",
};

describe("shared metadata recovery policy", () => {
  it("uses two actual primary failures, then one verified thread attempt", () => {
    const attempts: MetadataAttemptEvidence[] = [];
    for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
      expect(nextMetadataAction({ ...base, attempts })).toEqual({
        type: "attempt",
        stage: "primary",
        ordinal,
      });
      expect(metadataWarningRequired(true, attempts)).toBe(false);
      attempts.push(failed("primary"));
    }
    expect(metadataWarningRequired(true, attempts)).toBe(true);
    expect(nextMetadataAction({ ...base, attempts })).toEqual({
      type: "attempt",
      stage: "thread-model",
      ordinal: 1,
    });
    attempts.push(failed("thread-model", "thread"));
    expect(nextMetadataAction({ ...base, attempts })).toEqual({
      type: "terminal",
      state: "exhausted",
    });
  });

  it("does not pool failures from thread/native stages or invent an override warning", () => {
    expect(
      metadataWarningRequired(true, [failed("primary"), failed("thread-model"), failed("native")]),
    ).toBe(false);
    expect(
      metadataWarningRequired(false, [failed("primary"), failed("primary"), failed("primary")]),
    ).toBe(false);
  });

  it.each(["dispatch-intent", "acknowledged", "uncertain"] as const)(
    "%s prevents replay even after deadline or reset",
    (state) => {
      expect(
        nextMetadataAction({
          ...base,
          state: "cancelled",
          now: 1_000,
          attempts: [{ ...failed("primary"), state }],
        }),
      ).toEqual({ type: "reconcile" });
    },
  );

  it("retries persistence, not generation, when a result exists", () => {
    expect(
      nextMetadataAction({
        ...base,
        now: 1_000,
        attempts: [{ ...failed("primary"), state: "result-ready" }],
      }),
    ).toEqual({ type: "commit-result" });
  });

  it.each(["completed", "stale", "cancelled"] as const)("%s does not trigger fallback", (state) => {
    expect(nextMetadataAction({ ...base, attempts: [{ ...failed("primary"), state }] })).toEqual({
      type: "terminal",
      state,
    });
  });

  it("never repeats the same failed auxiliary execution target", () => {
    expect(
      nextMetadataAction({
        ...base,
        threadModelFingerprint: "primary",
        attempts: Array.from({ length: 2 }, () => failed("primary")),
      }),
    ).toEqual({ type: "terminal", state: "exhausted" });
  });

  it("uses a verified fallback immediately when the configured primary is unavailable", () => {
    expect(nextMetadataAction({ ...base, primaryFingerprint: null })).toEqual({
      type: "attempt",
      stage: "thread-model",
      ordinal: 1,
    });
  });

  it("waits a bounded time only when verified evidence is missing", () => {
    expect(
      nextMetadataAction({ ...base, primaryFingerprint: null, threadModelFingerprint: null }),
    ).toEqual({ type: "wait-model" });
    expect(nextMetadataAction({ ...base, primaryFingerprint: null, now: 6 })).toEqual({
      type: "attempt",
      stage: "thread-model",
      ordinal: 1,
    });
    expect(
      nextMetadataAction({
        ...base,
        primaryFingerprint: null,
        threadModelFingerprint: null,
        now: 6,
      }),
    ).toEqual({ type: "terminal", state: "unavailable" });
  });

  it("waits only within the model-readiness window for a missing fallback", () => {
    const attempts = Array.from({ length: 2 }, () => failed("primary"));
    expect(nextMetadataAction({ ...base, attempts, threadModelFingerprint: null })).toEqual({
      type: "wait-model",
    });
    expect(
      nextMetadataAction({
        ...base,
        attempts,
        threadModelFingerprint: null,
        now: base.modelWaitUntil,
      }),
    ).toEqual({ type: "terminal", state: "unavailable" });
    expect(
      nextMetadataAction({
        ...base,
        attempts: [...attempts, failed("thread-model", "thread")],
        threadModelFingerprint: null,
      }),
    ).toEqual({ type: "terminal", state: "unavailable" });
    expect(
      nextMetadataAction({
        ...base,
        attempts: [{ ...failed("primary"), state: "unavailable" }],
        threadModelFingerprint: null,
      }),
    ).toEqual({ type: "wait-model" });
  });

  it("preflight unavailability does not spend both primary attempts", () => {
    expect(
      nextMetadataAction({ ...base, attempts: [{ ...failed("primary"), state: "unavailable" }] }),
    ).toEqual({ type: "attempt", stage: "thread-model", ordinal: 1 });
  });

  it("does not deduplicate a path that was unavailable before dispatch", () => {
    expect(
      nextMetadataAction({
        ...base,
        threadModelFingerprint: "primary",
        attempts: [{ ...failed("primary"), state: "unavailable" }],
      }),
    ).toEqual({ type: "attempt", stage: "thread-model", ordinal: 1 });
  });

  it.each(["prepared", "failed", "uncertain", "result-ready"] as const)(
    "retires legacy native %s evidence without executing it",
    (state) => {
      expect(nextMetadataAction({ ...base, attempts: [{ ...failed("native"), state }] })).toEqual(
        state === "uncertain" || state === "result-ready"
          ? { type: "reconcile" }
          : { type: "terminal", state: "quarantined" },
      );
    },
  );

  it.each([
    "prepared",
    "dispatch-intent",
    "acknowledged",
    "uncertain",
    "result-ready",
    "failed",
  ] as const)("does not revive a historical no-override primary budget (%s)", (state) => {
    expect(
      nextMetadataAction({
        ...base,
        primaryFingerprint: null,
        threadModelFingerprint: "primary",
        attempts: [{ ...failed("primary"), state }],
      }),
    ).toEqual(
      state === "prepared"
        ? { type: "terminal", state: "quarantined" }
        : state === "result-ready"
          ? { type: "commit-result" }
          : state === "failed"
            ? { type: "terminal", state: "exhausted" }
            : { type: "reconcile" },
    );
  });

  it("resumes a prepared attempt, not another ordinal", () => {
    expect(
      nextMetadataAction({
        ...base,
        attempts: [failed("primary"), { ...failed("primary"), state: "prepared" }],
      }),
    ).toEqual({ type: "attempt", stage: "primary", ordinal: 2 });
  });
});

const path: MetadataExecutionPath = {
  selection: { provider: "codex", model: "test", options: { reasoningEffort: "high" } },
  transport: "local-app-server",
  accountIdentity: "opaque-account",
  executionTarget: "local",
  promptVersion: "title-v1",
  validatorVersion: "title-v1",
  mode: "auxiliary",
};
describe("execution-path fingerprints", () => {
  it("normalizes object ordering, not model options or execution context", () => {
    expect(metadataExecutionFingerprint(path)).toBe(
      metadataExecutionFingerprint({
        ...path,
        selection: { options: { reasoningEffort: "high" }, model: "test", provider: "codex" },
      }),
    );
    for (const changed of [
      { mode: "native" as const },
      { executionTarget: "remote:host" },
      { accountIdentity: "other" },
      { transport: "other" },
      { validatorVersion: "v2" },
      { promptVersion: "v2" },
      {
        selection: {
          provider: "codex" as const,
          model: "test",
          options: { reasoningEffort: "low" as const },
        },
      },
    ])
      expect(metadataExecutionFingerprint({ ...path, ...changed })).not.toBe(
        metadataExecutionFingerprint(path),
      );
  });
});
