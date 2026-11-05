import { describe, expect, it } from "vitest";

import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";

import { CodexModelSelectionError } from "../../../codex/codexAppServerManager.modelSelection.ts";
import { toRequestError, toStartSessionError } from "./Adapter.session.shared.ts";
import { CodexRpcError } from "../../../codex/codexAppServerManager.errors.ts";

const threadId = ThreadId.makeUnsafe("thread-1");

describe("Codex adapter model selection error mapping", () => {
  it("never authorizes session-dead replay from an upstream error string", () => {
    for (const cause of [
      new Error("Unknown session"),
      new CodexRpcError("turn/start", 2, "possibly-applied", "Unknown session"),
    ]) {
      const error = toRequestError(threadId, "turn/start", cause);
      expect(error._tag).toBe("ProviderAdapterRequestError");
      expect(error.failureClass).toBe(
        cause instanceof CodexRpcError ? "unsafe-to-replay" : undefined,
      );
      expect(error.cause).toBe(cause);
    }
  });
  it.each([
    [
      "catalog-unavailable",
      "Cannot validate Codex effort 'ultra' because the active model catalog is unavailable.",
    ],
    ["unknown-model", "Codex model 'gpt-unknown' is not present in the active model catalog."],
    ["unsupported-effort", "Codex model 'gpt-5.4' does not advertise reasoning effort 'ultra'."],
  ] as const)("maps startup %s failures to validation errors", (kind, issue) => {
    const cause = new CodexModelSelectionError(kind, issue);

    const error = toStartSessionError(threadId, cause);

    expect(error).toMatchObject({
      _tag: "ProviderAdapterValidationError",
      provider: "codex",
      operation: "startSession",
      issue,
    });
    expect(error.cause).toBe(cause);
  });

  it.each([
    [
      "catalog-unavailable",
      "Cannot validate Codex effort 'ultra' because the active model catalog is unavailable.",
    ],
    ["unknown-model", "Codex model 'gpt-unknown' is not present in the active model catalog."],
    ["unsupported-effort", "Codex model 'gpt-5.4' does not advertise reasoning effort 'ultra'."],
  ] as const)("maps turn %s failures to validation errors", (kind, issue) => {
    const cause = new CodexModelSelectionError(kind, issue);

    const error = toRequestError(threadId, "turn/start", cause);

    expect(error).toMatchObject({
      _tag: "ProviderAdapterValidationError",
      provider: "codex",
      operation: "turn/start",
      issue,
    });
    expect(error.cause).toBe(cause);
  });
});
