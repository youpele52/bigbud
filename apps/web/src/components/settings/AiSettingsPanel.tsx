import { SettingsPageContainer } from "./settingsLayout";
import { AiSettingsSection } from "./AiSettingsSection";
import { ComputerUseAccessSettingsSection } from "./ComputerUseAccessSettingsSection";
import { FileAccessSettingsSection } from "./FileAccessSettingsSection";
import { SttSettingsSection } from "./SttSettingsSection";
import { AgentBrowserSettingsSection } from "./AgentBrowserSettingsSection";

export function AiSettingsPanel() {
  return (
    <SettingsPageContainer>
      <FileAccessSettingsSection />
      <AgentBrowserSettingsSection />
      <ComputerUseAccessSettingsSection />
      <AiSettingsSection />
      <SttSettingsSection />
    </SettingsPageContainer>
  );
}
