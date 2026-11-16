import { CheckIcon, CopyIcon, TerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ServerGetRemoteAgentManualInstallResult } from "@bigbud/contracts/server/server.remoteAgentInstall";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { readNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";

interface SidebarRemoteAgentManualInstallProps {
  readonly executionTargetId: string;
  /** Expand immediately, for example after an automatic install failed. */
  readonly autoOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * Version-pinned remote command for staging the agent by hand. Running it only places verified
 * bytes on the host; the dialog's Finish install/update action registers and activates them.
 */
export function SidebarRemoteAgentManualInstall({
  executionTargetId,
  autoOpen,
  onOpenChange,
}: SidebarRemoteAgentManualInstallProps) {
  const [manual, setManual] = useState<ServerGetRemoteAgentManualInstallResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const load = async () => {
    if (loading) return;
    const api = readNativeApi();
    if (!api) {
      setError("Native API not found.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.server.getRemoteAgentManualInstall({ executionTargetId });
      setManual(result);
      onOpenChange(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare the remote command.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setManual(null);
    setError(null);
  }, [executionTargetId]);

  useEffect(() => {
    if (autoOpen && !manual) void load();
    // Load once per auto-open request; `load` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen, manual]);

  if (!manual) {
    return (
      <div className="space-y-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void load()}
        >
          <TerminalIcon aria-hidden />
          {loading ? "Preparing command..." : "Copy remote command"}
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-2">
      <p className="text-xs text-muted-foreground">
        Run this in a terminal on the remote host. It downloads agent {manual.version}, checks it
        against the published SHA-256 and places it in {manual.inboxRelativePath}. Nothing is active
        until you return here and choose Finish install/update.
      </p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
          {manual.command}
        </code>
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-label={isCopied ? "Copied remote command" : "Copy remote command"}
          onClick={() => copyToClipboard(manual.command)}
        >
          {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        If the host cannot reach bigbud.app, use the same script from the release:{" "}
        <span className="break-all font-mono">{manual.releaseScriptUrl}</span>
      </p>
    </div>
  );
}
