import { describe, expect, it } from "vitest";
import { normalizeHandoffModelSelection } from "./wsHandoffJobs.shared.ts";

describe("normalizeHandoffModelSelection", () => {
  it.each(["codex", "claudeAgent"] as const)("preserves the exact %s pair", (provider) => {
    const selection = { provider, model: "explicit-model" };
    expect(normalizeHandoffModelSelection(selection)).toBe(selection);
  });
  it("rejects unsupported providers rather than choosing Codex", () => {
    expect(() =>
      normalizeHandoffModelSelection({ provider: "cliProxy", model: "explicit-model" }),
    ).toThrow("cannot execute handoff");
  });
  it("does not silently switch away from a disabled preferred provider", () => {
    expect(() =>
      normalizeHandoffModelSelection({ provider: "claudeAgent", model: "explicit-model" }, [
        "codex",
      ]),
    ).toThrow("disabled");
  });
});
