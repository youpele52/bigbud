import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "../hooks/useLocalStorage";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  CLIENT_SETTINGS_STORAGE_OPTIONS,
  CLIENT_SETTINGS_LEGACY_KEYS,
} from "../hooks/useSettings.storage";

const { openBrowserPanel, addToast } = vi.hoisted(() => ({
  openBrowserPanel: vi.fn(),
  addToast: vi.fn(),
}));
vi.mock("../stores/browser/browserPanel.actions", () => ({ openBrowserPanel }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: addToast } }));

import { openLink, openLinkFromClick } from "./openLink";
import {
  createTerminalWebLinkHandler,
  openTerminalWebLink,
} from "../components/terminal/TerminalViewport.links.web";

function setPreference(enabled: boolean, key = CLIENT_SETTINGS_STORAGE_KEY) {
  setLocalStorageItem(
    key,
    { ...DEFAULT_CLIENT_SETTINGS, openWebLinksInApp: enabled },
    ClientSettingsSchema,
  );
}

beforeEach(() => {
  removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, CLIENT_SETTINGS_STORAGE_OPTIONS);
  vi.clearAllMocks();
});
afterEach(() => {
  removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, CLIENT_SETTINGS_STORAGE_OPTIONS);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("user web link routing", () => {
  it("defaults to embedded browsing without a saved setting", async () => {
    await openLink(" https://example.com/path ");
    expect(openBrowserPanel).toHaveBeenCalledWith({ url: "https://example.com/path" });
  });

  it("uses the desktop system browser when disabled and reads changes on every click", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { desktopBridge: { openExternal } });
    setPreference(false);
    await openLink("http://localhost:3000");
    expect(openExternal).toHaveBeenCalledWith("http://localhost:3000");
    expect(openBrowserPanel).not.toHaveBeenCalled();
    setPreference(true);
    await openLink("https://example.com");
    expect(openBrowserPanel).toHaveBeenCalledWith({ url: "https://example.com" });
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it.each(CLIENT_SETTINGS_LEGACY_KEYS)(
    "preserves explicit false while migrating %s",
    async (key) => {
      const open = vi.fn();
      vi.stubGlobal("window", { open });
      setPreference(false, key);
      await openLink("https://example.com");
      expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
      expect(
        getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema)?.openWebLinksInApp,
      ).toBe(false);
      expect(openBrowserPanel).not.toHaveBeenCalled();
    },
  );

  it("routes terminal plain text and OSC 8 links to the system browser when disabled", () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { desktopBridge: { openExternal } });
    vi.stubGlobal("navigator", { platform: "Linux" });
    setPreference(false);
    expect(openTerminalWebLink(" https://example.com/plain ")).toBe(true);
    createTerminalWebLinkHandler().activate(
      {
        button: 0,
        detail: 1,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      } as MouseEvent,
      "https://example.com/osc8",
    );
    expect(openExternal.mock.calls).toEqual([
      ["https://example.com/plain"],
      ["https://example.com/osc8"],
    ]);
    expect(openBrowserPanel).not.toHaveBeenCalled();
  });

  it("keeps system schemes external regardless of the web preference", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", { desktopBridge: { openExternal } });
    await openLink("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    await openLink("mailto:hello@example.com");
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openBrowserPanel).not.toHaveBeenCalled();
  });

  it("rejects unsafe/empty URLs and reports desktop failures", async () => {
    await expect(openLink(" ")).rejects.toThrow("Unable to open link.");
    await expect(openLink("javascript:alert(1)")).rejects.toThrow("Unsupported link protocol.");
    vi.stubGlobal("window", {
      desktopBridge: { openExternal: vi.fn().mockRejectedValue(new Error("failed")) },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setPreference(false);
    openLinkFromClick("https://example.com");
    await vi.waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({ type: "error", title: "Unable to open link." }),
    );
  });
});
