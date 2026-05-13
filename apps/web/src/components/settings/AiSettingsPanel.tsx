import { SettingsPageContainer } from "./settingsLayout";
import { AiSettingsSection } from "./AiSettingsSection";
import { SttSettingsSection } from "./SttSettingsSection";

export function AiSettingsPanel() {
  return (
    <SettingsPageContainer>
      <AiSettingsSection />
      <SttSettingsSection />
    </SettingsPageContainer>
  );
}
