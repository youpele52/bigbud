import "../../index.css";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProviderCard } from "./ProviderCard";
import { buildProviderCards } from "./ProvidersSettingsSection.logic";
import { cloneElement } from "react";

const noop = () => {};

it("defaults to shared native discovery and exposes private paths only in advanced isolated mode", async () => {
  const card = buildProviderCards({ settings: DEFAULT_UNIFIED_SETTINGS, serverProviders: [] }).find(
    (value) => value.provider === "opencodeV2",
  )!;
  const binary = vi.fn();
  const profile = vi.fn();
  const enable = vi.fn();
  const mode = vi.fn();
  const content = (
    <ProviderCard
      card={{ ...card, binaryPathValue: "/saved/opencode" }}
      isOpen
      codexHomePath="/saved/profile"
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
      onConnectionModeChange={mode}
      onCustomModelInputChange={noop}
      onAddCustomModel={noop}
      onRemoveCustomModel={noop}
    />
  );
  const screen = await render(content);
  try {
    await expect.element(page.getByRole("heading", { name: "OpenCode" })).toBeInTheDocument();
    await expect.element(page.getByRole("textbox", { name: /binary path/ })).toBeDisabled();
    expect(binary).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("textbox", { name: /Dedicated V2 profile path/ }))
      .not.toBeInTheDocument();
    await page
      .getByRole("combobox", { name: "OpenCode connection mode" })
      .selectOptions("isolated");
    expect(mode).toHaveBeenLastCalledWith("isolated");
    await screen.rerender(cloneElement(content, { connectionMode: "isolated" }));
    await expect.element(page.getByRole("textbox", { name: /binary path/ })).toBeEnabled();
    await expect
      .element(page.getByRole("textbox", { name: /binary path/ }))
      .toHaveValue("/saved/opencode");
    await expect
      .element(page.getByRole("textbox", { name: /Dedicated V2 profile path/ }))
      .toHaveValue("/saved/profile");
    await page.getByRole("textbox", { name: /binary path/ }).fill("/other/opencode");
    expect(binary).toHaveBeenLastCalledWith("/other/opencode");
    await page.getByRole("switch", { name: "Enable OpenCode" }).click();
    expect(enable.mock.calls[0]?.[0]).toBe(false);
  } finally {
    await screen.unmount();
  }
});
