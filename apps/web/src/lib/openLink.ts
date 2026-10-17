import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  CLIENT_SETTINGS_STORAGE_OPTIONS,
} from "../hooks/useSettings.storage";
import { openBrowserPanel } from "../stores/browser/browserPanel.actions";
import { toastManager } from "../components/ui/toast";
import { ensureBrowserLinkHost } from "./openLink.navigation";

/** Route user web links using the current preference; system schemes stay external. */
export async function openLink(value: string): Promise<void> {
  const url = value.trim();
  if (!url) throw new Error("Unable to open link.");
  const protocol = new URL(url).protocol;
  const isWeb = protocol === "http:" || protocol === "https:";
  if (!isWeb && protocol !== "mailto:" && protocol !== "x-apple.systempreferences:") {
    throw new Error("Unsupported link protocol.");
  }

  let settings = DEFAULT_CLIENT_SETTINGS;
  try {
    settings =
      getLocalStorageItem(
        CLIENT_SETTINGS_STORAGE_KEY,
        ClientSettingsSchema,
        CLIENT_SETTINGS_STORAGE_OPTIONS,
      ) ?? DEFAULT_CLIENT_SETTINGS;
  } catch (error) {
    console.error("Unable to read web link preference:", error);
  }

  if (isWeb && settings.openWebLinksInApp) {
    const navigation = ensureBrowserLinkHost();
    if (navigation) await navigation;
    openBrowserPanel({ url });
  } else if (window.desktopBridge) {
    if (!(await window.desktopBridge.openExternal(url))) {
      throw new Error("Unable to open link.");
    }
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Report link-opening failures for fire-and-forget UI event handlers. */
export function openLinkFromClick(url: string): void {
  void openLink(url).catch((error) => {
    console.error("Unable to open link:", error);
    toastManager.add({ type: "error", title: "Unable to open link." });
  });
}
