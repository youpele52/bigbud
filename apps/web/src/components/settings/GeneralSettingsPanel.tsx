import { SettingsPageContainer } from "./settingsLayout";
import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { LearningProjectsSettingsSection } from "./LearningProjectsSettingsSection";
import { ThreadRetentionSettingsSection } from "./ThreadRetentionSettingsSection";
import { BrowserSettingsSection } from "./BrowserSettingsSection";
import { TerminalSettingsSection } from "./TerminalSettingsSection";

export function GeneralSettingsPanel() {
  return (
    <SettingsPageContainer>
      <GeneralSettingsSection />
      <ThreadRetentionSettingsSection />
      <BrowserSettingsSection />
      <TerminalSettingsSection />
      <LearningProjectsSettingsSection />
    </SettingsPageContainer>
  );
}
