import { afterEach, describe, expect, it, vi } from "vitest";

function installThemeGlobals(setTheme: ReturnType<typeof vi.fn>) {
  const storage = {
    getItem: vi.fn(() => "dark"),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  };
  const matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const classList = {
    add: vi.fn(),
    remove: vi.fn(),
    toggle: vi.fn(),
  };

  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    localStorage: storage,
    matchMedia,
    desktopBridge: { setTheme },
  });
  vi.stubGlobal("document", {
    documentElement: { classList },
  });
}

describe("useTheme desktop integration", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("does not send the app theme to Electron's process-wide native theme", async () => {
    const setTheme = vi.fn(async () => undefined);
    installThemeGlobals(setTheme);

    await import("./useTheme");

    expect(setTheme).not.toHaveBeenCalled();
  });
});
