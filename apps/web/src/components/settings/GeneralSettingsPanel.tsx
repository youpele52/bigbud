import { SettingsPageContainer } from "./settingsLayout";
import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { LearningProjectsSettingsSection } from "./LearningProjectsSettingsSection";
import { ThreadRetentionSettingsSection } from "./ThreadRetentionSettingsSection";

export function GeneralSettingsPanel() {
  return (
    <SettingsPageContainer>
      <GeneralSettingsSection />
      <ThreadRetentionSettingsSection />
      <LearningProjectsSettingsSection />
    </SettingsPageContainer>
  );
}
