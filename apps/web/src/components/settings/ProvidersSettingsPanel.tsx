import type { ProviderKind } from "@bigbud/contracts";

import { SettingsPageContainer } from "./settingsLayout";
import { ComposerProvidersSettingsSection } from "./ComposerProvidersSettingsSection";
import { ProvidersSettingsSection } from "./ProvidersSettingsSection";

export function ProvidersSettingsPanel({
  expandedProviders = [],
}: {
  readonly expandedProviders?: ReadonlyArray<ProviderKind>;
}) {
  return (
    <SettingsPageContainer>
      <ProvidersSettingsSection expandedProviders={expandedProviders} />
      <ComposerProvidersSettingsSection />
    </SettingsPageContainer>
  );
}
