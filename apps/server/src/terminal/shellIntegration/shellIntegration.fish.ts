import { fishAgentWrappers } from "./shellIntegration.agents.ts";

/**
 * fish: loaded from bigbud's `vendor_conf.d` (via XDG_DATA_DIRS), after which bigbud's data
 * directory is removed from XDG_DATA_DIRS again. Emits OSC 133 C/D only.
 */
export function fishScript(): string {
  return `# bigbud pane shell integration. Emits OSC 133 C/D only; never changes your prompt.
if set -q BIGBUD_FISH_DATA_DIR
  set -l dirs (string split ':' -- "$XDG_DATA_DIRS")
  set -l index (contains -i -- "$BIGBUD_FISH_DATA_DIR" $dirs)
  and set -e dirs[$index]
  if test (count $dirs) -gt 0
    set -gx XDG_DATA_DIRS (string join ':' -- $dirs)
  else
    set -e XDG_DATA_DIRS
  end
  set -e BIGBUD_FISH_DATA_DIR
end
if status is-interactive; and not set -q __bigbud_integrated
  set -g __bigbud_integrated 1
  if not set -q ITERM_SHELL_INTEGRATION_INSTALLED; and not set -q VSCODE_SHELL_INTEGRATION
    function __bigbud_preexec --on-event fish_preexec
      printf '\\033]133;C;cmdline_url=%s\\007' (string escape --style=url -- (string sub -l 240 -- "$argv[1]"))
      set -g __bigbud_started 1
    end
    function __bigbud_postexec --on-event fish_postexec
      set -l s $status
      if set -q __bigbud_started
        set -e __bigbud_started
        printf '\\033]133;D;%s\\007' $s
      end
    end
  end
${fishAgentWrappers().trim()}
end
`;
}
