import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopPreferencesStore } from "./desktopPreferences";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "bigbud-desktop-preferences-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { force: true, recursive: true });
  }
});

describe("DesktopPreferencesStore", () => {
  it("defaults the floating assistant on with the matte-black hand", () => {
    const store = new DesktopPreferencesStore(createTemporaryDirectory(), () => undefined);

    expect(store.get().floatingAssistantEnabled).toBe(true);
    expect(store.get().floatingAssistantCaller).toBe("matte");
    expect(store.get().mascotVisible).toBe(true);
  });

  it("migrates the legacy mascot caller to matte black", () => {
    const directory = createTemporaryDirectory();
    FS.writeFileSync(
      Path.join(directory, "desktop-preferences.json"),
      JSON.stringify({
        version: 1,
        floatingAssistantEnabled: true,
        floatingAssistantCaller: "mascot",
        mascotVisible: true,
        mascotBounds: null,
      }),
      "utf8",
    );

    const store = new DesktopPreferencesStore(directory, () => undefined);

    expect(store.get().floatingAssistantCaller).toBe("matte");
  });

  it("persists the chrome hand caller", () => {
    const directory = createTemporaryDirectory();
    const store = new DesktopPreferencesStore(directory, () => undefined);

    store.update({ floatingAssistantCaller: "chrome" });

    const restored = new DesktopPreferencesStore(directory, () => undefined);
    expect(restored.get().floatingAssistantCaller).toBe("chrome");
  });
});
