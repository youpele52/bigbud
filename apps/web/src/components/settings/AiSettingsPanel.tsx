import { SettingsPageContainer } from "./settingsLayout";
import { AiSettingsSection } from "./AiSettingsSection";
import { ComputerUseAccessSettingsSection } from "./ComputerUseAccessSettingsSection";
import { FileAccessSettingsSection } from "./FileAccessSettingsSection";
import { SttSettingsSection } from "./SttSettingsSection";

export function AiSettingsPanel() {
  return (
    <SettingsPageContainer>
      <FileAccessSettingsSection />
      <ComputerUseAccessSettingsSection />
      <AiSettingsSection />
      <SttSettingsSection />
    </SettingsPageContainer>
  );
}
