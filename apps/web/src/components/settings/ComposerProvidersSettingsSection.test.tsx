import type { ProviderKind } from "@bigbud/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ hiddenComposerProviders: [] as ProviderKind[] }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (value: typeof settings) => unknown) => selector(settings),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));

import { ComposerProvidersSettingsSection } from "./ComposerProvidersSettingsSection";

describe("composer provider visibility settings", () => {
  it.each([
    { hidden: [] as ProviderKind[] },
    { hidden: ["opencode"] as ProviderKind[] },
    { hidden: ["opencodeV2"] as ProviderKind[] },
  ])("renders only the V2 OpenCode row with hidden preferences $hidden", ({ hidden }) => {
    settings.hiddenComposerProviders = hidden;
    const markup = renderToStaticMarkup(<ComposerProvidersSettingsSection />);
    const toggles = markup.match(/<[^>]*aria-label="Show OpenCode in composer"[^>]*>/g) ?? [];
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toContain(`aria-checked="${!hidden.includes("opencodeV2")}"`);
  });
});
