import { posixAgentWrappers } from "./shellIntegration.agents.ts";

/** Shells that already emit OSC 133 themselves; the server also ignores duplicate markers. */
const KNOWN_INTEGRATIONS =
  '[[ -n "$ITERM_SHELL_INTEGRATION_INSTALLED" || -n "$VSCODE_SHELL_INTEGRATION" ]]';

/** Percent-encodes $1 (first 240 bytes) into REPLY without a subshell per character. */
const URL_ENCODE = `
__bigbud_urlencode() {
  local LC_ALL=C s="\${1:0:240}" out="" c hex i
  for (( i = 0; i < \${#s}; i++ )); do
    c="\${s:$i:1}"
    case "$c" in
      [a-zA-Z0-9._~/=:,+@-]) out+="$c" ;;
      *) printf -v hex '%%%02X' "'$c"; out+="$hex" ;;
    esac
  done
  REPLY="$out"
}`;

/**
 * zsh: bigbud's ZDOTDIR holds only this `.zshenv`. It restores the user's ZDOTDIR at once (so
 * zsh reads the user's own .zprofile/.zshrc/.zlogin), sources the user's .zshenv, and installs
 * hooks at the first prompt, after the user's configuration. Only OSC 133 C/D are emitted; the
 * prompt text is never touched.
 */
export function zshEnvScript(): string {
  return `# bigbud pane shell integration. Emits OSC 133 C/D only; never changes your prompt.
if [[ -n "\${BIGBUD_ZSH_ZDOTDIR+X}" ]]; then
  ZDOTDIR="$BIGBUD_ZSH_ZDOTDIR"; unset BIGBUD_ZSH_ZDOTDIR
else
  unset ZDOTDIR
fi
if [[ -r "\${ZDOTDIR:-$HOME}/.zshenv" ]]; then
  source "\${ZDOTDIR:-$HOME}/.zshenv"
fi
if [[ -o interactive && -n "$BIGBUD_SHELL_INTEGRATION_DIR" && -z "$__bigbud_integrated" ]]; then
  __bigbud_integrated=1
  autoload -Uz add-zsh-hook
  __bigbud_install() {
    add-zsh-hook -d precmd __bigbud_install
    ${KNOWN_INTEGRATIONS} && return
    __bigbud_started=
${indent(URL_ENCODE, 4)}
    __bigbud_preexec() {
      __bigbud_urlencode "$1"
      printf '\\033]133;C;cmdline_url=%s\\007' "$REPLY"
      __bigbud_started=1
    }
    __bigbud_precmd() {
      local s=$?
      if [[ -n "$__bigbud_started" ]]; then
        __bigbud_started=
        printf '\\033]133;D;%s\\007' "$s"
      fi
      return $s
    }
    # First precmd hook, so it reads the command's own exit status.
    precmd_functions=(__bigbud_precmd $precmd_functions)
    add-zsh-hook preexec __bigbud_preexec
${indent(
  posixAgentWrappers((name) => `(( \${+functions[${name}]} ))`),
  4,
)}
  }
  add-zsh-hook precmd __bigbud_install
fi
`;
}

/**
 * bash: an exported PROMPT_COMMAND bootstrap sources this file at the first prompt (after the
 * user's .bashrc). It removes itself from PROMPT_COMMAND, wraps the remaining commands between
 * the precmd and an end marker, and uses a DEBUG trap for preexec only when no other DEBUG trap
 * exists. A .bashrc that overwrites PROMPT_COMMAND disables the integration (the process-poll
 * fallback remains).
 */
export function bashScript(bootstrap: string): string {
  return `# bigbud pane shell integration. Emits OSC 133 C/D only; never changes your prompt.
if [[ -z "$__bigbud_integrated" ]]; then
  __bigbud_integrated=1
  __bigbud_bootstrap=${shellQuote(bootstrap)}
  __bigbud_pc="\${PROMPT_COMMAND//"$__bigbud_bootstrap"/}"
  while [[ "$__bigbud_pc" == *";;"* || "$__bigbud_pc" == *"; ;"* ]]; do
    __bigbud_pc="\${__bigbud_pc//; ;/;}"; __bigbud_pc="\${__bigbud_pc//;;/;}"
  done
  while [[ "$__bigbud_pc" == [\\;\\ ]* ]]; do __bigbud_pc="\${__bigbud_pc#?}"; done
  PROMPT_COMMAND="$__bigbud_pc"
  unset __bigbud_pc
  export -n PROMPT_COMMAND 2>/dev/null
  if ! ${KNOWN_INTEGRATIONS} && [[ -z "$(trap -p DEBUG)" && -z "$__bp_imported" ]]; then
    __bigbud_started=
    __bigbud_at_prompt=
${indent(URL_ENCODE, 4)}
    __bigbud_precmd() {
      local s=$?
      __bigbud_at_prompt=
      if [[ -n "$__bigbud_started" ]]; then
        __bigbud_started=
        printf '\\033]133;D;%s\\007' "$s"
      fi
      return $s
    }
    __bigbud_prompt_end() {
      local s=$?
      __bigbud_at_prompt=1
      return $s
    }
    __bigbud_preexec() {
      [[ -n "$__bigbud_at_prompt" && -z "$COMP_LINE" ]] || return 0
      # The prompt that installed us is still running its remaining PROMPT_COMMAND parts.
      if [[ -n "$__bigbud_arming" ]]; then
        [[ "$PROMPT_COMMAND" == *"$BASH_COMMAND"* ]] && return 0
        __bigbud_arming=
      fi
      __bigbud_at_prompt=
      __bigbud_urlencode "$BASH_COMMAND"
      printf '\\033]133;C;cmdline_url=%s\\007' "$REPLY"
      __bigbud_started=1
    }
    PROMPT_COMMAND="__bigbud_precmd
\${PROMPT_COMMAND:+$PROMPT_COMMAND
}__bigbud_prompt_end"
    __bigbud_trap=1
  fi
${indent(
  posixAgentWrappers((name) => `declare -F ${name} >/dev/null`),
  2,
)}
  # Armed last, so nothing in this file is reported as a command.
  if [[ -n "$__bigbud_trap" ]]; then
    unset __bigbud_trap
    __bigbud_arming=1
    __bigbud_at_prompt=1
    trap '__bigbud_preexec' DEBUG
  fi
fi
`;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .trim()
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
