import { useState } from "react";
import { readNativeApi } from "../../rpc/nativeApi";
import { Button } from "../ui/button";
import type { SshConfigHostsState } from "./SidebarRemoteWorkspaceDialog.sshConfigHosts";
import {
  createRemoteWorkspaceExecutionTargetId,
  type RemoteWorkspaceDraft,
} from "./Sidebar.remoteWorkspaces.logic";

export function devSshOwnerTargetId(hosts: SshConfigHostsState): string | undefined {
  return hosts.status === "ready" ? hosts.result.developmentOwnerTargetId : undefined;
}

export function RemoteWorkspaceDevOwnerControls({
  draft,
  targetId,
}: {
  draft: RemoteWorkspaceDraft;
  targetId: string;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = createRemoteWorkspaceExecutionTargetId(draft) === targetId;

  async function change(disconnected: boolean) {
    const server = readNativeApi()?.server;
    if (!server || !selected || busy) return;
    setBusy(true);
    try {
      const input = { executionTargetId: createRemoteWorkspaceExecutionTargetId(draft) };
      const result = await (disconnected
        ? server.disconnectExecutionTarget(input)
        : server.connectExecutionTarget(input));
      setMessage(result.disconnected ? "Disconnected" : "Connected; browse to verify SSH access.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not change the connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Rust SSH owner"
      className="space-y-2 rounded-lg border border-border p-3 text-sm"
    >
      <p className="font-medium">Rust SSH owner (development)</p>
      <p className="text-xs text-muted-foreground">
        Select the listed SSH alias with Direct SSH to browse the disposable fixture.
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!selected || busy}
          onClick={() => void change(false)}
        >
          Connect
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!selected || busy}
          onClick={() => void change(true)}
        >
          Disconnect
        </Button>
      </div>
      <p role="status" className="text-xs">
        {message}
      </p>
    </section>
  );
}
