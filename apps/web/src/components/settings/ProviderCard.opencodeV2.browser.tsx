import "../../index.css";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ProviderCard } from "./ProviderCard";
import { buildProviderCards } from "./ProvidersSettingsSection.logic";
import { cloneElement } from "react";

const noop = () => {};

it("exposes shared native setup only and preserves retained isolated configuration as read-only", async () => {
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
    await expect
      .element(page.getByRole("textbox", { name: /binary path/ }))
      .not.toBeInTheDocument();
    expect(binary).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("textbox", { name: /Dedicated V2 profile path/ }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("combobox", { name: "OpenCode connection mode" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Retry setup", includeHidden: true }))
      .not.toBeVisible();
    await page.getByText("Thread tools & setup", { exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Retry setup" })).toBeVisible();
    await screen.rerender(cloneElement(content, { connectionMode: "isolated" }));
    await expect
      .element(page.getByRole("textbox", { name: /binary path/ }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: /Dedicated V2 profile path/ }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Use shared native service for new chats" }).click();
    expect(mode).toHaveBeenLastCalledWith("shared");
    expect(binary).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    await page.getByRole("switch", { name: "Enable OpenCode" }).click();
    expect(enable.mock.calls[0]?.[0]).toBe(false);
  } finally {
    await screen.unmount();
  }
});
