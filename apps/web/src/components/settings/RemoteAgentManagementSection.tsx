import { useState } from "react";

import { useStore } from "../../stores/main/main.store";
import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import type { SidebarRemoteAgentInstallRequest } from "../sidebar/Sidebar.remoteWorkspaceAddActions.types";
import { createRemoteWorkspaceDraft } from "../sidebar/Sidebar.remoteWorkspaces.logic";
import { SidebarRemoteAgentInstallDialog } from "../sidebar/SidebarRemoteAgentInstallDialog";
import { SettingsSection } from "./settingsLayout";
import { useRemoteAgentHostActions } from "./RemoteAgentManagementSection.actions";
import { RemoteAgentHostRow, RemoteAgentNotice } from "./RemoteAgentManagementSection.host";
import { buildRemoteAgentHosts, type RemoteAgentHost } from "./RemoteAgentManagementSection.logic";
import { RemoteAgentRemoveDialog } from "./RemoteAgentManagementSection.remove";

export function RemoteAgentManagementSection() {
  const projects = useStore((state) => state.projects);
  const disconnectedExecutionTargetIds = useRemoteAccessStore(
    (state) => state.disconnectedExecutionTargetIds,
  );
  const verifiedExecutionTargetIds = useRemoteAccessStore(
    (state) => state.verifiedExecutionTargetIds,
  );
  const executionTargetChecks = useRemoteAccessStore((state) => state.executionTargetChecks);
  const remoteConnections = useRemoteAccessStore((state) => state.remoteConnections);
  const actions = useRemoteAgentHostActions();
  const [finishRequest, setFinishRequest] = useState<SidebarRemoteAgentInstallRequest | null>(null);
  const [removeHost, setRemoveHost] = useState<RemoteAgentHost | null>(null);
  const hosts = buildRemoteAgentHosts(projects, {
    disconnectedExecutionTargetIds,
    verifiedExecutionTargetIds,
    executionTargetChecks,
    remoteConnections,
  });
  // A removal can move every workspace off a host; keep its outcome visible at the top.
  const orphanNotices = Object.entries(actions.notices).filter(
    ([target]) => !hosts.some((host) => host.target === target),
  );
  const openFinishInstall = (host: RemoteAgentHost) => {
    const candidate = host.projects[0] ? createRemoteWorkspaceDraft(host.projects[0]) : null;
    if (candidate)
      setFinishRequest({
        kind: "install",
        candidate,
        executionTargetId: host.target,
        targetLabel: host.hostLabel,
      });
  };
  return (
    <SettingsSection title="Remote agents">
      {orphanNotices.map(([target, notice]) => (
        <div key={target} className="space-y-1 border-t p-4 first:border-t-0">
          <p className="text-sm font-medium">{notice.hostLabel}</p>
          <RemoteAgentNotice notice={notice} />
        </div>
      ))}
      {hosts.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">Saved remote hosts appear here.</p>
      ) : null}
      {hosts.map((host) => (
        <RemoteAgentHostRow
          key={host.target}
          host={host}
          removed={actions.removed[host.target] === true}
          installed={actions.installed[host.target] === true}
          busyAction={actions.busy?.target === host.target ? actions.busy.action : null}
          anyBusy={actions.busy !== null}
          notice={actions.notices[host.target]}
          onUpdate={() => void actions.update(host)}
          onReplaceNow={() => void actions.replaceNow(host)}
          onInstall={() => void actions.install(host)}
          onRemove={() => setRemoveHost(host)}
          onFinishInstall={() => openFinishInstall(host)}
          onSwitchToAgent={() => void actions.switchToAgent(host)}
        />
      ))}
      <RemoteAgentRemoveDialog
        key={removeHost?.target ?? "closed"}
        host={removeHost}
        onCancel={() => setRemoveHost(null)}
        onConfirm={(host, switchWorkspacesToDirectSsh) => {
          setRemoveHost(null);
          void actions.remove(host, switchWorkspacesToDirectSsh);
        }}
      />
      <SidebarRemoteAgentInstallDialog
        request={finishRequest}
        onDecline={() => setFinishRequest(null)}
        onInstalled={async (message) => {
          if (finishRequest)
            actions.notify(finishRequest.executionTargetId, {
              hostLabel: finishRequest.targetLabel,
              tone: "success",
              message,
            });
          setFinishRequest(null);
        }}
      />
    </SettingsSection>
  );
}
