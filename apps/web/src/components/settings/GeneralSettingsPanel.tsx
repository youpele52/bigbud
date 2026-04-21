import { SettingsPageContainer } from "./settingsLayout";
import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { NotificationsSettingsSection } from "./NotificationsSettingsSection";
import { AdvancedSettingsSection } from "./AdvancedSettingsSection";
import { AboutSettingsSection } from "./AboutSettingsSection";
import { ProvidersSettingsSection } from "./ProvidersSettingsSection";

export { useSettingsRestore } from "./useSettingsRestore";

export function GeneralSettingsPanel() {
  return (
    <SettingsPageContainer>
      <GeneralSettingsSection />
      <ProvidersSettingsSection />
      <NotificationsSettingsSection />
      <AdvancedSettingsSection />
      <AboutSettingsSection />
    </SettingsPageContainer>
  );
}
