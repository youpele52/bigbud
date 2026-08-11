import { BigbudLogo } from "../sidebar/SidebarProjectItem";
import { useSettingsSearch } from "./SettingsSearch.context";
import { normalizeSettingsSearchQuery } from "./SettingsSearch.logic";
import { SettingsPageContainer } from "./settingsLayout";
import { AboutSettingsSection } from "./AboutSettingsSection";

function AboutProductHeader() {
  const { query } = useSettingsSearch();

  if (normalizeSettingsSearchQuery(query)) {
    return null;
  }

  return (
    <div className="flex h-[33.333dvh] w-full flex-col items-center justify-center bg-inherit">
      <BigbudLogo className="h-8 opacity-70" />
    </div>
  );
}

export function AboutSettingsPanel() {
  return (
    <SettingsPageContainer>
      <AboutProductHeader />
      <AboutSettingsSection />
    </SettingsPageContainer>
  );
}
