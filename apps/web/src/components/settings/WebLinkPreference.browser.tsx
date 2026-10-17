import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { DesktopBridge } from "@bigbud/contracts";
import { ClientSettingsSchema } from "@bigbud/contracts/core/settings.ts";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  CLIENT_SETTINGS_STORAGE_OPTIONS,
} from "../../hooks/useSettings.storage";
import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { BaseMarkdown } from "../common/BaseMarkdown";
import { useBrowserPanelStore } from "../../stores/browser/browser.store";

afterEach(() => {
  removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, CLIENT_SETTINGS_STORAGE_OPTIONS);
  delete window.desktopBridge;
});

it("persists the default-on switch and routes markdown clicks through the chosen browser", async () => {
  removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, CLIENT_SETTINGS_STORAGE_OPTIONS);
  const openExternal = vi.fn().mockResolvedValue(true);
  window.desktopBridge = { openExternal } as unknown as DesktopBridge;
  const settings = await render(
    <AppAtomRegistryProvider>
      <GeneralSettingsSection />
    </AppAtomRegistryProvider>,
  );
  try {
    const toggle = page.getByRole("switch", { name: "Open web links in bigbud" });
    await expect.element(toggle).toBeChecked();
    await toggle.click();
    await expect.element(toggle).not.toBeChecked();
    expect(
      getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema)?.openWebLinksInApp,
    ).toBe(false);
  } finally {
    await settings.unmount();
  }

  const markdown = await render(
    <BaseMarkdown cwd="/workspace" text="[Example](https://example.com/preference)" />,
  );
  try {
    await page.getByRole("link", { name: "Example" }).click();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/preference");
  } finally {
    await markdown.unmount();
  }

  const remounted = await render(
    <AppAtomRegistryProvider>
      <GeneralSettingsSection />
    </AppAtomRegistryProvider>,
  );
  try {
    const toggle = page.getByRole("switch", { name: "Open web links in bigbud" });
    await expect.element(toggle).not.toBeChecked();
    await toggle.click();
    await expect.element(toggle).toBeChecked();
  } finally {
    await remounted.unmount();
  }
  const embeddedMarkdown = await render(
    <BaseMarkdown cwd="/workspace" text="[Embedded](https://example.com/embedded)" />,
  );
  try {
    await page.getByRole("link", { name: "Embedded" }).click();
    expect(openExternal).toHaveBeenCalledTimes(1);
    await page.getByRole("link", { name: "Embedded" }).click({ button: "middle" });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(
      Object.values(useBrowserPanelStore.getState().tabsById).some(
        (tab) => tab.url === "https://example.com/embedded",
      ),
    ).toBe(true);
  } finally {
    await embeddedMarkdown.unmount();
  }
});
