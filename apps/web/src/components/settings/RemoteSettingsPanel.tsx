import { RemoteAgentManagementSection } from "./RemoteAgentManagementSection";
import { SettingsPageContainer } from "./settingsLayout";
import { MobileRemoteControlSettingsSection } from "./MobileRemoteControlSettingsSection";
import { PeerPairingSettingsSection } from "./PeerPairingSettingsSection";

export function RemoteSettingsPanel() {
  return (
    <SettingsPageContainer>
      <MobileRemoteControlSettingsSection />
      <RemoteAgentManagementSection />
      <PeerPairingSettingsSection />
    </SettingsPageContainer>
  );
}
