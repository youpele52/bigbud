import { describe, expect, it } from "vitest";

import { modelsFromCliProxyPreflight } from "./Provider.ts";

describe("CLIProxy model discovery", () => {
  it("maps management-authenticated sources to Claude-harness-compatible identifiers", () => {
    expect(
      modelsFromCliProxyPreflight([
        { id: "gpt-5", source: "codex" },
        { id: "claude-sonnet", source: "claude" },
      ]),
    ).toMatchObject([
      { slug: "gpt-5", group: "Codex", subProviderID: "codex" },
      { slug: "claude-sonnet", group: "Claude", subProviderID: "claude" },
    ]);
  });
});
