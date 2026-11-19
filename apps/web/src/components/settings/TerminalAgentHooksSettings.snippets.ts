/** Copyable completion hooks for tools bigbud does not inject (or for panes outside bigbud). */
export interface TerminalAgentHookSnippet {
  readonly tool: string;
  readonly where: string;
  readonly snippet: string;
  /** Injected automatically inside bigbud panes when the setting is on. */
  readonly injected: boolean;
}

/** Exact completion marker; bigbud stores nothing from it except the time. */
export const AGENT_DONE_PRINTF = String.raw`printf '\033]777;bigbud;done\007' > /dev/tty`;

export const TERMINAL_AGENT_HOOK_SNIPPETS: ReadonlyArray<TerminalAgentHookSnippet> = [
  {
    tool: "Claude Code",
    where: "~/.claude/settings.json (hooks run without a terminal, so Claude Code emits it)",
    injected: true,
    snippet: String.raw`{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "printf '{\"terminalSequence\":\"\\u001b]777;bigbud;done\\u0007\"}'"
          }
        ]
      }
    ]
  }
}`,
  },
  {
    tool: "Codex CLI",
    where: "~/.codex/config.toml (replaces any existing notify command)",
    injected: true,
    snippet: String.raw`notify = ["sh", "-c", "printf '\\033]777;bigbud;done\\007' > /dev/tty"]`,
  },
  {
    tool: "OpenCode",
    where: "~/.config/opencode/plugin/bigbud-done.js",
    injected: false,
    snippet: String.raw`import { closeSync, openSync, writeSync } from "node:fs";

export const BigbudDone = async () => ({
  event: async ({ event }) => {
    if (event.type !== "session.idle") return;
    try {
      const tty = openSync("/dev/tty", "w");
      writeSync(tty, "\x1b]777;bigbud;done\x07");
      closeSync(tty);
    } catch {}
  },
});`,
  },
  {
    tool: "herdr and other tools",
    where: "the tool's own completion hook or script",
    injected: false,
    snippet: AGENT_DONE_PRINTF,
  },
];
