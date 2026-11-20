import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronRightIcon, CopyIcon, FileIcon, FilePlusIcon } from "lucide-react";
import { useState } from "react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { cn } from "../../lib/utils";
import { isBoundBackendWindow } from "../../rpc/backendScope.state";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { useServerConfig } from "../../rpc/serverState";
import { openFileInFilesPanel } from "../../stores/files/filesPanel.coordinator";
import { SyntaxHighlightedCode } from "../chat/common/SyntaxHighlightedCode";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  createHookConfigFile,
  resolveHookConfigFile,
} from "./TerminalAgentHooksSettings.configFile";
import type { TerminalAgentHookSnippet } from "./TerminalAgentHooksSettings.snippets";

function hookStatusText(entry: TerminalAgentHookSnippet): string {
  if (entry.injected) return "Added automatically in bigbud panes";
  return entry.configPath ? "Add this file yourself" : "Add to the tool's hook yourself";
}

/** Opens the config file in the Files panel, which only exists outside the settings routes. */
function openHookConfigFile(directory: string, fileName: string): void {
  openFileInFilesPanel(fileName, null, directory);
  window.history.back();
}

function HookConfigFileAction({ configPath, snippet }: { configPath: string; snippet: string }) {
  const homeDir = useServerConfig()?.homeDir;
  const queryClient = useQueryClient();
  const queryKey = ["settings", "terminal-agent-hook-config", configPath, homeDir];
  const fileQuery = useQuery({
    queryKey,
    queryFn: () => resolveHookConfigFile(ensureNativeApi(), configPath, homeDir),
    retry: false,
  });
  const createMutation = useMutation({
    mutationFn: (home: string) =>
      createHookConfigFile(ensureNativeApi(), configPath, home, `${snippet}\n`),
    onSuccess: (location) => {
      void queryClient.invalidateQueries({ queryKey });
      openHookConfigFile(location.directory, location.fileName);
    },
  });
  const state = fileQuery.data;
  if (state?.status === "exists") {
    return (
      <Button
        size="xs"
        variant="outline"
        aria-label={`Open ${configPath} in bigbud`}
        onClick={() => openHookConfigFile(state.directory, state.fileName)}
      >
        <FileIcon className="size-3.5" />
        Open {configPath}
      </Button>
    );
  }
  if (state?.status === "missing" && homeDir) {
    return (
      <div className="space-y-1">
        <Button
          size="xs"
          variant="outline"
          disabled={createMutation.isPending}
          onClick={() => createMutation.mutate(homeDir)}
        >
          <FilePlusIcon className="size-3.5" />
          Create {configPath} with this snippet
        </Button>
        {createMutation.error ? (
          <p role="alert" className="text-xs text-destructive">
            Could not create {configPath}: {createMutation.error.message}
          </p>
        ) : null}
      </div>
    );
  }
  return null;
}

function HookSnippetBody({ entry }: { entry: TerminalAgentHookSnippet }) {
  const { resolvedTheme } = useTheme();
  // A remote backend's home folder is not this machine's, so only the path text is shown.
  const configPath = isBoundBackendWindow() ? undefined : entry.configPath;
  return (
    <div className="space-y-2 pt-2 pl-5">
      {entry.note ? <p className="text-xs text-muted-foreground">{entry.note}</p> : null}
      {configPath ? <HookConfigFileAction configPath={configPath} snippet={entry.snippet} /> : null}
      <div className="chat-markdown">
        <SyntaxHighlightedCode
          code={entry.snippet}
          language={entry.language}
          themeName={resolveDiffThemeName(resolvedTheme)}
          fallback={
            <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
              {entry.snippet}
            </pre>
          }
        />
      </div>
    </div>
  );
}

/** One collapsed-by-default hook row; Copy works without expanding it. */
export function TerminalAgentHookItem({ entry }: { entry: TerminalAgentHookSnippet }) {
  const [open, setOpen] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-start justify-between gap-2">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-start gap-1.5 rounded-sm text-left">
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              {entry.tool}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {hookStatusText(entry)}
              </span>
            </span>
            <span className="block break-all text-xs text-muted-foreground">{entry.where}</span>
          </span>
        </CollapsibleTrigger>
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
      <CollapsiblePanel>
        <HookSnippetBody entry={entry} />
      </CollapsiblePanel>
    </Collapsible>
  );
}
