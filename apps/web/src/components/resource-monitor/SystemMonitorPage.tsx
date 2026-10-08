import { usePageTitle } from "~/hooks/usePageTitle";
import { StandaloneChatPageHeader } from "../standalone/StandaloneChatPageHeader";
import { StandaloneChatPageShell } from "../standalone/StandaloneChatPageShell";
import { StandalonePageContent } from "../standalone/StandalonePageContent";
import { SystemMonitorHostView } from "./SystemMonitorHostView";
import { BigbudResourceView } from "./BigbudResourceView";
import { MonitorScopeToggle, type MonitorScope } from "./MonitorScopeToggle";

export function SystemMonitorPage({
  scope,
  onScopeChange,
}: {
  scope: MonitorScope;
  onScopeChange: (scope: MonitorScope) => void;
}) {
  usePageTitle(scope === "bigbud" ? "bigbud Monitor" : "System Monitor");
  return (
    <StandaloneChatPageShell header={<StandaloneChatPageHeader title="System Monitor" />}>
      <StandalonePageContent contentClassName="space-y-5 pb-10">
        <MonitorScopeToggle scope={scope} onScopeChange={onScopeChange} />
        {scope === "system" ? <SystemMonitorHostView /> : <BigbudResourceView visible large />}
      </StandalonePageContent>
    </StandaloneChatPageShell>
  );
}
