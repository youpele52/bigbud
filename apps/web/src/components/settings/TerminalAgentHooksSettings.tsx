import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { TerminalAgentHookItem } from "./TerminalAgentHooksSettings.item";
import { TERMINAL_AGENT_HOOK_SNIPPETS } from "./TerminalAgentHooksSettings.snippets";

/** "Detect when terminal agents finish" and copyable hooks for tools bigbud cannot inject. */
export function TerminalAgentHooksSettings() {
  const enabled = useSettings((settings) => settings.terminalAgentHooksEnabled);
  const { updateSettings } = useUpdateSettings();
  return (
    <>
      <SettingsRow
        title="Detect when terminal agents finish"
        description="Inside bigbud panes, Claude Code and Codex get a completion hook at launch so a finished turn moves the thread to Needs you. Your own config files are never changed. Applies to new panes."
        searchTerms={["hooks", "claude", "codex", "needs you"]}
        control={
          <Switch
            tone="success"
            checked={enabled}
            onCheckedChange={(checked) =>
              updateSettings({ terminalAgentHooksEnabled: Boolean(checked) })
            }
            aria-label="Detect when terminal agents finish"
          />
        }
      />
      <SettingsRow
        title="Terminal agent hooks"
        description="For tools bigbud does not add hooks to, or terminals on other machines: each hook prints one marker to its own terminal and sends no content."
        searchTerms={["opencode", "herdr", "snippet", "hook"]}
      >
        <div className="space-y-3 pt-2">
          {TERMINAL_AGENT_HOOK_SNIPPETS.map((entry) => (
            <TerminalAgentHookItem key={entry.tool} entry={entry} />
          ))}
        </div>
      </SettingsRow>
    </>
  );
}
