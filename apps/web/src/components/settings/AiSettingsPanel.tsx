import { SettingsPageContainer } from "./settingsLayout";
import { AiSettingsSection } from "./AiSettingsSection";
import { ComputerUseAccessSettingsSection } from "./ComputerUseAccessSettingsSection";
import { FileAccessSettingsSection } from "./FileAccessSettingsSection";
import { SttSettingsSection } from "./SttSettingsSection";
import { FloatingAssistantSettingsSection } from "./FloatingAssistantSettingsSection";
import { DelegatedThreadsSettingsSection } from "./DelegatedThreadsSettingsSection";

export function AiSettingsPanel() {
  return (
    <SettingsPageContainer>
      <FileAccessSettingsSection />
      <FloatingAssistantSettingsSection />
      <ComputerUseAccessSettingsSection />
      <DelegatedThreadsSettingsSection />
      <AiSettingsSection />
      <SttSettingsSection />
    </SettingsPageContainer>
  );
}
