import { describe, expect, it } from "vitest";

import { asClaudeModelSelection } from "./Adapter.ts";

describe("CLIProxy adapter", () => {
  it("delegates the selected proxy model through the private Claude harness", () => {
    expect(
      asClaudeModelSelection({
        provider: "cliProxy",
        model: "claude-sonnet-4-6",
        options: { effort: "high", thinking: true },
        subProviderID: "claude",
      }),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      options: { effort: "high", thinking: true },
    });
  });
});
