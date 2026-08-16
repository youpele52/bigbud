import { SettingsPageContainer } from "./settingsLayout";
import { AiSettingsSection } from "./AiSettingsSection";
import { ComputerUseAccessSettingsSection } from "./ComputerUseAccessSettingsSection";
import { FileAccessSettingsSection } from "./FileAccessSettingsSection";
import { SttSettingsSection } from "./SttSettingsSection";
import { AgentBrowserSettingsSection } from "./AgentBrowserSettingsSection";
import { FloatingAssistantSettingsSection } from "./FloatingAssistantSettingsSection";

export function AiSettingsPanel() {
  return (
    <SettingsPageContainer>
      <FileAccessSettingsSection />
      <AgentBrowserSettingsSection />
      <FloatingAssistantSettingsSection />
      <ComputerUseAccessSettingsSection />
      <AiSettingsSection />
      <SttSettingsSection />
    </SettingsPageContainer>
  );
}
