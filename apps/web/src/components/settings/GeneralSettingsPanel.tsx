import { SettingsPageContainer } from "./settingsLayout";
import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { NotificationsSettingsSection } from "./NotificationsSettingsSection";
import { AdvancedSettingsSection } from "./AdvancedSettingsSection";
import { AboutSettingsSection } from "./AboutSettingsSection";
import { ProvidersSettingsSection } from "./ProvidersSettingsSection";
import { SttSettingsSection } from "./SttSettingsSection";

export { useSettingsRestore } from "./useSettingsRestore";

export function GeneralSettingsPanel() {
  return (
    <SettingsPageContainer>
      <GeneralSettingsSection />
      <ProvidersSettingsSection />
      <SttSettingsSection />
      <NotificationsSettingsSection />
      <AdvancedSettingsSection />
      <AboutSettingsSection />
    </SettingsPageContainer>
  );
}
