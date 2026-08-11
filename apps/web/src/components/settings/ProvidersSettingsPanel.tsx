import type { ProviderKind } from "@bigbud/contracts";

import { SettingsPageContainer } from "./settingsLayout";
import { ProvidersSettingsSection } from "./ProvidersSettingsSection";

export function ProvidersSettingsPanel({
  expandedProviders = [],
}: {
  readonly expandedProviders?: ReadonlyArray<ProviderKind>;
}) {
  return (
    <SettingsPageContainer>
      <ProvidersSettingsSection expandedProviders={expandedProviders} />
    </SettingsPageContainer>
  );
}
