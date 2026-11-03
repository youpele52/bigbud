import { usePageTitle } from "~/hooks/usePageTitle";
import { StandaloneChatPageHeader } from "../standalone/StandaloneChatPageHeader";
import { StandaloneChatPageShell } from "../standalone/StandaloneChatPageShell";
import { StandalonePageContent } from "../standalone/StandalonePageContent";
import { StandalonePageLoading } from "../standalone/StandalonePageLoading";
import { SystemMonitorHostView } from "./SystemMonitorHostView";
import { BigbudResourceView } from "./BigbudResourceView";
import { MonitorScopeToggle, type MonitorScope } from "./MonitorScopeToggle";
import { useSystemMonitorPageLoading } from "./SystemMonitorPage.loading";

export function SystemMonitorPage({
  scope,
  onScopeChange,
}: {
  scope: MonitorScope;
  onScopeChange: (scope: MonitorScope) => void;
}) {
  usePageTitle(scope === "bigbud" ? "bigbud Monitor" : "System Monitor");
  const loading = useSystemMonitorPageLoading(scope);
  return (
    <StandaloneChatPageShell header={<StandaloneChatPageHeader title="System Monitor" />}>
      <StandalonePageContent contentClassName="flex min-h-full flex-col gap-5 pb-10">
        <MonitorScopeToggle scope={scope} onScopeChange={onScopeChange} />
        <StandalonePageLoading
          loading={loading}
          label={scope === "system" ? "Loading system resources" : "Loading bigbud resources"}
        >
          {scope === "system" ? <SystemMonitorHostView /> : <BigbudResourceView visible large />}
        </StandalonePageLoading>
      </StandalonePageContent>
    </StandaloneChatPageShell>
  );
}
