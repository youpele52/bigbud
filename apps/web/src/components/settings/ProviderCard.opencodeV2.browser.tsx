import "../../index.css";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProviderCard } from "./ProviderCard";
import { buildProviderCards } from "./ProvidersSettingsSection.logic";

it("shows independent preview enable, binary and profile controls without a server development flag", async () => {
  const card = buildProviderCards({ settings: DEFAULT_UNIFIED_SETTINGS, serverProviders: [] }).find(
    (value) => value.provider === "opencodeV2",
  )!;
  const binary = vi.fn();
  const profile = vi.fn();
  const enable = vi.fn();
  const noop = () => {};
  const screen = await render(
    <ProviderCard
      card={card}
      isOpen
      codexHomePath=""
      customModelInput=""
      customModelError={null}
      modelListRef={{ current: null }}
      onToggleOpen={noop}
      onOpenChange={noop}
      onResetProvider={noop}
      onToggleEnabled={enable}
      onBinaryPathChange={binary}
      onConfigPathChange={noop}
      onOpenSetupGuide={noop}
      onHomePathChange={profile}
      onCustomModelInputChange={noop}
      onAddCustomModel={noop}
      onRemoveCustomModel={noop}
    />,
  );
  try {
    await expect
      .element(page.getByRole("heading", { name: "OpenCode v2 (Preview)" }))
      .toBeInTheDocument();
    await page.getByRole("textbox", { name: /binary path/ }).fill("/separate/opencode-v2");
    expect(binary).toHaveBeenLastCalledWith("/separate/opencode-v2");
    await page
      .getByRole("textbox", { name: /Dedicated V2 profile path/ })
      .fill("/private/new-v2-profile");
    expect(profile).toHaveBeenLastCalledWith("/private/new-v2-profile");
    await page.getByRole("switch", { name: "Enable OpenCode v2 (Preview)" }).click();
    expect(enable.mock.calls[0]?.[0]).toBe(true);
  } finally {
    await screen.unmount();
  }
});
