/**
 * Thin agent wrappers defined only inside bigbud panes (by the pane shell integration). Each adds
 * a completion hook at launch without touching the user's files, and calls the real binary
 * unchanged when the setting is off, the flag is unsupported, the user already configured the
 * hook, or the invocation is non-interactive. Existing user functions of the same name win.
 */

/** Claude Code subcommands and flags that never run an interactive turn. */
const CLAUDE_SKIP =
  "mcp|config|doctor|update|upgrade|install|setup-token|plugin|plugins|migrate-installer|auth|agents|-p|--print|-v|--version|-h|--help";
/** Codex subcommands that are not the interactive TUI. */
const CODEX_SKIP =
  "exec|e|login|logout|mcp|mcp-server|app-server|completion|sandbox|debug|apply|a|doctor|features|cloud|help|-h|--help|-V|--version";

/** zsh and bash share POSIX function syntax; `exists` tests for a user function or alias. */
export function posixAgentWrappers(exists: (name: string) => string): string {
  return `
__bigbud_agent_args_skip() {
  local skip="$1"; shift
  local arg
  for arg in "$@"; do
    case "|$skip|" in *"|$arg|"*) return 0 ;; esac
    case "$arg" in -*) ;; *) return 1 ;; esac
  done
  return 1
}
__bigbud_claude_supported() {
  if [[ -z "$__bigbud_claude_probe" ]]; then
    if command claude --help 2>/dev/null | grep -q -- '--settings'; then __bigbud_claude_probe=yes
    else __bigbud_claude_probe=no; fi
  fi
  [[ "$__bigbud_claude_probe" == yes ]]
}
__bigbud_codex_supported() {
  if [[ -z "$__bigbud_codex_probe" ]]; then
    if command codex --help 2>/dev/null | grep -q -- '--config'; then __bigbud_codex_probe=yes
    else __bigbud_codex_probe=no; fi
  fi
  [[ "$__bigbud_codex_probe" == yes ]] || return 1
  # notify is a single value: never replace the user's own.
  ! grep -Eqs '^[[:space:]]*notify[[:space:]]*=' "\${CODEX_HOME:-$HOME/.codex}/config.toml"
}
if ! ${exists("claude")}; then
claude() {
  if [[ -n "$BIGBUD_TERMINAL_AGENT_HOOKS" && -r "$BIGBUD_CLAUDE_HOOKS" ]] \\
    && ! __bigbud_agent_args_skip "${CLAUDE_SKIP}" "$@" && __bigbud_claude_supported; then
    command claude --settings "$BIGBUD_CLAUDE_HOOKS" "$@"
  else
    command claude "$@"
  fi
}
fi
if ! ${exists("codex")}; then
codex() {
  if [[ -n "$BIGBUD_TERMINAL_AGENT_HOOKS" && -n "$BIGBUD_CODEX_NOTIFY" ]] \\
    && ! __bigbud_agent_args_skip "${CODEX_SKIP}" "$@" && __bigbud_codex_supported; then
    command codex -c "notify=$BIGBUD_CODEX_NOTIFY" "$@"
  else
    command codex "$@"
  fi
}
fi
`;
}

export function fishAgentWrappers(): string {
  return `
function __bigbud_agent_args_skip
  set -l skip (string split '|' -- $argv[1])
  for arg in $argv[2..-1]
    if contains -- $arg $skip; return 0; end
    if not string match -q -- '-*' $arg; return 1; end
  end
  return 1
end
if not functions -q claude
  function claude --wraps claude
    if set -q BIGBUD_TERMINAL_AGENT_HOOKS; and test -r "$BIGBUD_CLAUDE_HOOKS"; and not __bigbud_agent_args_skip '${CLAUDE_SKIP}' $argv; and command claude --help 2>/dev/null | string match -q -- '*--settings*'
      command claude --settings "$BIGBUD_CLAUDE_HOOKS" $argv
    else
      command claude $argv
    end
  end
end
if not functions -q codex
  function codex --wraps codex
    set -l config (set -q CODEX_HOME; and echo $CODEX_HOME; or echo $HOME/.codex)/config.toml
    if set -q BIGBUD_TERMINAL_AGENT_HOOKS; and set -q BIGBUD_CODEX_NOTIFY; and not __bigbud_agent_args_skip '${CODEX_SKIP}' $argv; and command codex --help 2>/dev/null | string match -q -- '*--config*'; and not grep -Eqs '^[[:space:]]*notify[[:space:]]*=' $config
      command codex -c "notify=$BIGBUD_CODEX_NOTIFY" $argv
    else
      command codex $argv
    end
  end
end
`;
}

export const AGENT_SKIP_LISTS = { claude: CLAUDE_SKIP, codex: CODEX_SKIP } as const;
