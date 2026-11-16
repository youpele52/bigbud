import { useState } from "react";
import { useStore } from "../../stores/main/main.store";
import { readNativeApi } from "../../rpc/nativeApi";
import {
  createRemoteWorkspaceDraft,
  parseRemoteExecutionTarget,
} from "../sidebar/Sidebar.remoteWorkspaces.logic";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { SidebarRemoteAgentInstallDialog } from "../sidebar/SidebarRemoteAgentInstallDialog";
import type { SidebarRemoteAgentInstallRequest } from "../sidebar/Sidebar.remoteWorkspaceAddActions.types";
import { SidebarRemoteAgentManualInstall } from "../sidebar/SidebarRemoteAgentManualInstall";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

export function RemoteAgentManagementSection() {
  const projects = useStore((state) => state.projects);
  const [request, setRequest] = useState<SidebarRemoteAgentInstallRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ target: string; message: string; error: boolean } | null>(
    null,
  );
  const hosts = new Map<string, (typeof projects)[number]>();
  for (const project of projects) {
    const target = resolveWorkspaceExecutionTargetId(project);
    if (target && parseRemoteExecutionTarget(target)?.remoteTransport === "agent")
      hosts.set(target, project);
  }
  const replace = async (target: string) => {
    if (busy) return;
    setBusy(target);
    setNotice(null);
    try {
      const api = readNativeApi();
      if (!api) throw new Error("Native API not found.");
      const result = await api.server.installRemoteAgent({
        executionTargetId: target,
        replace: true,
      });
      setNotice({
        target,
        message: result.message,
        error: result.outcome === "failed",
      });
    } catch (cause) {
      setNotice({
        target,
        message: cause instanceof Error ? cause.message : "Replacement did not complete.",
        error: true,
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsSection title="Remote agents">
      {hosts.size === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">Saved remote agent hosts appear here.</p>
      ) : null}
      {[...hosts].map(([target, project]) => (
        <div key={target} className="space-y-3 border-t p-4 first:border-t-0">
          <p className="text-sm font-medium">{parseRemoteExecutionTarget(target)?.host}</p>
          <p className="text-xs text-muted-foreground">
            Install or stage an update, then connect explicitly. Replace activates a verified build
            and cleans up only unused predecessors; live work is preserved.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy !== null}
              variant="outline"
              onClick={() => {
                const candidate = createRemoteWorkspaceDraft(project);
                if (candidate)
                  setRequest({
                    kind: "install",
                    candidate,
                    executionTargetId: target,
                    targetLabel: parseRemoteExecutionTarget(target)!.host,
                  });
              }}
            >
              Install / stage update
            </Button>
            <Button disabled={busy !== null} variant="outline" onClick={() => void replace(target)}>
              {busy === target ? "Replacing…" : "Replace"}
            </Button>
          </div>
          <SidebarRemoteAgentManualInstall
            executionTargetId={target}
            autoOpen={false}
            onOpenChange={() => {}}
          />
          <p className="text-xs text-muted-foreground">
            After running the remote command, choose Install / stage update to finish adoption, then
            Connect new session.
          </p>
          {notice?.target === target ? (
            <p role={notice.error ? "alert" : "status"} className="text-sm">
              {notice.message}
            </p>
          ) : null}
        </div>
      ))}
      <SidebarRemoteAgentInstallDialog
        request={request}
        onDecline={() => setRequest(null)}
        onInstalled={async (message) => {
          if (request) setNotice({ target: request.executionTargetId, message, error: false });
          setRequest(null);
        }}
      />
    </SettingsSection>
  );
}
