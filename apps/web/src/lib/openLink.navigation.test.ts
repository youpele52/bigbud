import { afterEach, expect, it, vi } from "vitest";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { removeLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  CLIENT_SETTINGS_STORAGE_OPTIONS,
} from "../hooks/useSettings.storage";
import { registerBrowserLinkRouter } from "./openLink.navigation";

const openBrowserPanel = vi.hoisted(() => vi.fn());
vi.mock("../stores/browser/browserPanel.actions", () => ({ openBrowserPanel }));
import { openLink } from "./openLink";

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  removeLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, CLIENT_SETTINGS_STORAGE_OPTIONS);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("waits for the browser host route before opening enabled links from settings or global actions", async () => {
  let finish!: () => void;
  const navigate = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  unregister = registerBrowserLinkRouter({
    state: { matches: [{ routeId: "/settings" }] },
    navigate,
  });
  const opening = openLink("https://example.com");
  expect(navigate).toHaveBeenCalledWith({ to: "/" });
  expect(openBrowserPanel).not.toHaveBeenCalled();
  finish();
  await opening;
  expect(openBrowserPanel).toHaveBeenCalledWith({ url: "https://example.com" });
});

it("does not leave an existing chat or compact-handoff thread route", async () => {
  const navigate = vi.fn();
  unregister = registerBrowserLinkRouter({
    state: { matches: [{ routeId: "/_chat" }, { routeId: "/_chat/$threadId" }] },
    navigate,
  });
  await openLink("https://example.com");
  expect(navigate).not.toHaveBeenCalled();
  expect(openBrowserPanel).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "opens disabled links synchronously without route changes (desktop: %s)",
  async (desktop) => {
    const external = vi.fn().mockResolvedValue(true);
    vi.stubGlobal(
      "window",
      desktop ? { desktopBridge: { openExternal: external } } : { open: external },
    );
    setLocalStorageItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      { ...DEFAULT_CLIENT_SETTINGS, openWebLinksInApp: false },
      ClientSettingsSchema,
    );
    const navigate = vi.fn();
    unregister = registerBrowserLinkRouter({
      state: { matches: [{ routeId: "/settings" }] },
      navigate,
    });
    const opening = openLink("https://example.com");
    expect(external).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    expect(openBrowserPanel).not.toHaveBeenCalled();
    await opening;
  },
);

it("does not silently open a hidden panel after navigation fails", async () => {
  unregister = registerBrowserLinkRouter({
    state: { matches: [{ routeId: "/settings" }] },
    navigate: vi.fn().mockRejectedValue(new Error("navigation failed")),
  });
  await expect(openLink("https://example.com")).rejects.toThrow("navigation failed");
  expect(openBrowserPanel).not.toHaveBeenCalled();
});
