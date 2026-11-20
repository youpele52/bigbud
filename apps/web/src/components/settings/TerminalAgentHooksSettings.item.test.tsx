import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TerminalAgentHookItem } from "./TerminalAgentHooksSettings.item";
import { TERMINAL_AGENT_HOOK_SNIPPETS } from "./TerminalAgentHooksSettings.snippets";

describe("terminal agent hook rows", () => {
  it("render collapsed with the status, path and a labelled Copy button", () => {
    const markup = renderToStaticMarkup(
      <TerminalAgentHookItem entry={TERMINAL_AGENT_HOOK_SNIPPETS[0]!} />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("Added automatically in bigbud panes");
    expect(markup).toContain("~/.claude/settings.json");
    expect(markup).toContain('aria-label="Copy Claude Code hook"');
    expect(markup).not.toContain("terminalSequence");
  });

  it("marks snippet-only tools as manual", () => {
    const markup = renderToStaticMarkup(
      <TerminalAgentHookItem entry={TERMINAL_AGENT_HOOK_SNIPPETS[3]!} />,
    );

    expect(markup).toContain("Add to the tool&#x27;s hook yourself");
  });
});
