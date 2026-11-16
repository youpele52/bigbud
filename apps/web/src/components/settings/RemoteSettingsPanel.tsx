import { RemoteAgentManagementSection } from "./RemoteAgentManagementSection";
import { SettingsPageContainer } from "./settingsLayout";
import { MobileRemoteControlSettingsSection } from "./MobileRemoteControlSettingsSection";

export function RemoteSettingsPanel() {
  return (
    <SettingsPageContainer>
      <MobileRemoteControlSettingsSection />
      <RemoteAgentManagementSection />
    </SettingsPageContainer>
  );
}
