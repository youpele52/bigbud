import { describe, expect, it } from "vitest";

import {
  normalizeModelSelection,
  normalizeProviderModelOptions,
} from "./normalization.store.models";

describe("CLIProxyAPI persisted effort", () => {
  it.each(["low", "medium", "high", "xhigh", "max"])("preserves %s during hydration", (effort) => {
    expect(normalizeProviderModelOptions({ cliProxy: { effort: ` ${effort} ` } })).toEqual({
      cliProxy: { effort },
    });
    expect(
      normalizeModelSelection({
        provider: "cliProxy",
        model: "gpt-6-astra",
        options: { effort },
      }),
    ).toEqual({ provider: "cliProxy", model: "gpt-6-astra", options: { effort } });
  });

  it.each(["", "   ", null, 1])("drops invalid effort %s", (effort) => {
    expect(normalizeProviderModelOptions({ cliProxy: { effort } })).toBeNull();
  });
});

describe("normalizeProviderModelOptions Codex effort", () => {
  it("preserves trimmed dynamic effort values", () => {
    expect(
      normalizeProviderModelOptions({ codex: { reasoningEffort: "  future-depth  " } }, "codex"),
    ).toMatchObject({ codex: { reasoningEffort: "future-depth" } });
    expect(
      normalizeProviderModelOptions(undefined, "codex", { effort: "  legacy-depth  " }),
    ).toMatchObject({ codex: { reasoningEffort: "legacy-depth" } });
  });

  it("drops blank effort values", () => {
    expect(
      normalizeProviderModelOptions({ codex: { reasoningEffort: "   " } }, "codex"),
    ).toBeNull();
  });
});

describe("normalizeProviderModelOptions opaque provider efforts", () => {
  it("preserves OpenCode, Cursor, and Devin custom identifiers", () => {
    expect(
      normalizeProviderModelOptions({ opencode: { reasoningEffort: " none " } }, "opencode"),
    ).toMatchObject({ opencode: { reasoningEffort: "none" } });
    expect(normalizeProviderModelOptions({ cursor: { reasoning: "max" } }, "cursor")).toMatchObject(
      { cursor: { reasoning: "max" } },
    );
    expect(
      normalizeProviderModelOptions({ cursor: { reasoningEffort: "max" } }, "cursor"),
    ).toMatchObject({ cursor: { reasoning: "max" } });
    expect(normalizeProviderModelOptions({ devin: { reasoning: "max" } }, "devin")).toMatchObject({
      devin: { reasoning: "max" },
    });
  });
});

describe("normalizeProviderModelOptions Claude effort", () => {
  it("preserves trimmed future and legacy prompt-injected effort values", () => {
    expect(
      normalizeProviderModelOptions({ claudeAgent: { effort: "  future-depth  " } }, "claudeAgent"),
    ).toMatchObject({ claudeAgent: { effort: "future-depth" } });
    expect(
      normalizeProviderModelOptions({ claudeAgent: { effort: "ultrathink" } }, "claudeAgent"),
    ).toMatchObject({ claudeAgent: { effort: "ultrathink" } });
  });

  it("drops blank Claude effort values", () => {
    expect(
      normalizeProviderModelOptions({ claudeAgent: { effort: "   " } }, "claudeAgent"),
    ).toBeNull();
  });
});
