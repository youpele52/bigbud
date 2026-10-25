import { version } from "../../../package.json" with { type: "json" };

/**
 * Terminal identity for interactive PTYs (Orca sets the same keys). xterm.js renders truecolor, but
 * apps launched from the Dock/Finder inherit no COLORTERM, which makes TUIs such as opencode fall
 * back to 256 colours. Overriding TERM_PROGRAM also stops a parent terminal's identity (for example
 * iTerm.app) leaking in and enabling escape sequences xterm.js does not implement.
 */
export function withInteractiveTerminalIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "bigbud",
    TERM_PROGRAM_VERSION: version,
  };
}
