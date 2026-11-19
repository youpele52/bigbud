import { describe, expect, it } from "vitest";
import { TERMINAL_AGENT_HOOK_SNIPPETS } from "./TerminalAgentHooksSettings.snippets";

describe("terminal agent hook snippets", () => {
  it("every snippet prints exactly the bigbud done marker", () => {
    for (const entry of TERMINAL_AGENT_HOOK_SNIPPETS)
      expect(entry.snippet).toMatch(/777;bigbud;done/);
  });

  it("the Claude Code snippet is valid settings JSON with a Stop hook", () => {
    const claude = TERMINAL_AGENT_HOOK_SNIPPETS.find((entry) => entry.tool === "Claude Code")!;
    const parsed = JSON.parse(claude.snippet);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain("terminalSequence");
  });

  it("OpenCode and herdr are snippet-only", () => {
    expect(
      TERMINAL_AGENT_HOOK_SNIPPETS.filter((entry) => !entry.injected).map((e) => e.tool),
    ).toEqual(["OpenCode", "herdr and other tools"]);
  });
});
