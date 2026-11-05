import { usePageTitle } from "~/hooks/usePageTitle";
import { StandaloneChatPageHeader } from "../standalone/StandaloneChatPageHeader";
import { StandaloneChatPageShell } from "../standalone/StandaloneChatPageShell";
import { StandalonePageContent } from "../standalone/StandalonePageContent";
import { StandalonePageLoading } from "../standalone/StandalonePageLoading";
import { SystemMonitorHostView } from "./SystemMonitorHostView";
import { BigbudResourceView } from "./BigbudResourceView";
import { MonitorScopeToggle, type MonitorScope } from "./MonitorScopeToggle";
import { useSystemMonitorPageLoading } from "./SystemMonitorPage.loading";
import { useConnectedSshMonitorProjects } from "./useConnectedSshMonitorProjects";
import { availableMonitorScope, connectedRemoteMonitorScopes } from "./monitorRemoteScopes";
import { useRemoteMonitor } from "./useRemoteMonitor";
import { useConnectedSshMonitorStore } from "~/stores/resource-monitor/remoteMonitor.connections.store";
import { CenteredStatus } from "../common/CenteredStatus";
import { useEffect } from "react";

export function SystemMonitorPage({
  scope,
  onScopeChange,
}: {
  scope: MonitorScope;
  onScopeChange: (scope: MonitorScope) => void;
}) {
  const projects = useConnectedSshMonitorProjects();
  const discoveryStatus = useConnectedSshMonitorStore((state) => state.status);
  const remotes = connectedRemoteMonitorScopes(projects);
  const selected = remotes.find((entry) => entry.scope === scope);
  const effectiveScope = availableMonitorScope(scope, remotes);
  const awaitingRemote = scope.startsWith("vps:") && !selected && discoveryStatus !== "ready";
  useEffect(() => {
    if (!awaitingRemote && effectiveScope !== scope) onScopeChange("system");
  }, [awaitingRemote, effectiveScope, scope, onScopeChange]);
  const remote = useRemoteMonitor(selected?.target ?? null, selected?.scope.slice(4) ?? null);
  usePageTitle(effectiveScope === "bigbud" ? "bigbud Monitor" : "System Monitor");
  const loading = useSystemMonitorPageLoading(effectiveScope === "bigbud" ? "bigbud" : "system");
  return (
    <StandaloneChatPageShell header={<StandaloneChatPageHeader title="System Monitor" />}>
      <StandalonePageContent contentClassName="flex min-h-full flex-col gap-5 pb-10">
        <MonitorScopeToggle
          scope={awaitingRemote ? scope : effectiveScope}
          onScopeChange={onScopeChange}
          remotes={remotes}
        />
        {awaitingRemote ? (
          <CenteredStatus loading={discoveryStatus === "pending"}>
            {discoveryStatus === "pending"
              ? "Checking VPS connection"
              : "SSH connection status unavailable; retrying"}
          </CenteredStatus>
        ) : selected ? (
          <SystemMonitorHostView
            remote={{ name: selected.name, ...(remote ? { state: remote } : {}) }}
          />
        ) : (
          <StandalonePageLoading
            loading={loading}
            label={
              effectiveScope === "system" ? "Loading system resources" : "Loading bigbud resources"
            }
          >
            {effectiveScope === "system" ? (
              <SystemMonitorHostView />
            ) : (
              <BigbudResourceView visible large />
            )}
          </StandalonePageLoading>
        )}
      </StandalonePageContent>
    </StandaloneChatPageShell>
  );
}
