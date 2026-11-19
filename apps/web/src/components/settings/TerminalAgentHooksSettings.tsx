import { CheckIcon, CopyIcon } from "lucide-react";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import {
  TERMINAL_AGENT_HOOK_SNIPPETS,
  type TerminalAgentHookSnippet,
} from "./TerminalAgentHooksSettings.snippets";

function SnippetBlock({ entry }: { entry: TerminalAgentHookSnippet }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {entry.tool}
            {entry.injected ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                Added automatically in bigbud panes
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">{entry.where}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          aria-label={`Copy ${entry.tool} hook`}
          onClick={() => copyToClipboard(entry.snippet)}
        >
          {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {isCopied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
        {entry.snippet}
      </pre>
    </div>
  );
}

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
            <SnippetBlock key={entry.tool} entry={entry} />
          ))}
        </div>
      </SettingsRow>
    </>
  );
}
