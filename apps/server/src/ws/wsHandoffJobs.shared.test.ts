import { describe, expect, it } from "vitest";

import { normalizeHandoffModelSelection } from "./wsHandoffJobs.shared.ts";

describe("normalizeHandoffModelSelection", () => {
  it.each([
    ["codex", { provider: "codex", model: "gpt-5.4-mini" }],
    ["claudeAgent", { provider: "claudeAgent", model: "haiku" }],
  ] as const)("keeps supported %s selection", (_provider, selection) => {
    expect(normalizeHandoffModelSelection(selection)).toEqual(selection);
  });

  it("falls back CLIProxy to Codex when Codex is available", () => {
    expect(
      normalizeHandoffModelSelection({ provider: "cliProxy", model: "gpt-5-codex" }, [
        "codex",
        "claudeAgent",
      ]),
    ).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
  });

  it("fails explicitly when no supported fallback is available", () => {
    expect(() =>
      normalizeHandoffModelSelection({ provider: "cliProxy", model: "gpt-5-codex" }, ["cliProxy"]),
    ).toThrowError(
      expect.objectContaining({
        operation: "normalizeHandoffModelSelection",
        detail: expect.stringContaining("no supported fallback"),
      }),
    );
  });
});
