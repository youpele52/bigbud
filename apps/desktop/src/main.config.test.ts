import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { App } from "electron";

import { resolveDesktopMainConfig } from "./main.config";

const originalEnvironment = { ...process.env };

function appForVersion(version: string, isPackaged = true): App {
  return {
    getVersion: () => version,
    isPackaged,
    runningUnderARM64Translation: false,
  } as App;
}

describe("resolveDesktopMainConfig", () => {
  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it.each([
    ["1.2.3", "bigbud", "bigbud", [], "ai.bigbud.desktop", "T3 Code (Alpha)"],
    [
      "1.2.3-beta.1",
      "bigbud Beta",
      "bigbud-beta",
      ["channels", "beta"],
      "ai.bigbud.desktop.beta",
      null,
    ],
    [
      "1.2.3-preview.1",
      "bigbud Preview",
      "bigbud-preview",
      ["channels", "preview"],
      "ai.bigbud.desktop.preview",
      null,
    ],
    [
      "1.2.3-nightly.1",
      "bigbud Nightly",
      "bigbud-nightly",
      ["channels", "nightly"],
      "ai.bigbud.desktop.nightly",
      null,
    ],
  ] as const)(
    "isolates runtime identity for %s",
    (version, displayName, dataName, suffix, appId, legacyName) => {
      delete process.env.VITE_DEV_SERVER_URL;
      delete process.env.BIGBUD_HOME;
      delete process.env.T3CODE_HOME;

      const config = resolveDesktopMainConfig(appForVersion(version), "/repo/apps/desktop/dist");

      expect(config.appDisplayName).toBe(displayName);
      expect(config.userDataDirName).toBe(dataName);
      expect(config.baseDir).toBe(Path.join(OS.homedir(), ".bigbud", ...suffix));
      expect(config.appUserModelId).toBe(appId);
      expect(config.cuaDriverHostBundleId).toBe(appId);
      expect(config.legacyUserDataDirName).toBe(legacyName);
      expect(config.linuxDesktopEntryName).toBe(`${dataName}.desktop`);
      expect(config.linuxWmClass).toBe(dataName);
    },
  );

  it.each(["BIGBUD_HOME", "T3CODE_HOME"])("honors exact %s override", (name) => {
    delete process.env.VITE_DEV_SERVER_URL;
    delete process.env.BIGBUD_HOME;
    delete process.env.T3CODE_HOME;
    process.env[name] = "/tmp/exact-bigbud-home";

    const config = resolveDesktopMainConfig(
      appForVersion("1.2.3-preview.1"),
      "/repo/apps/desktop/dist",
    );

    expect(config.baseDir).toBe("/tmp/exact-bigbud-home");
  });

  it("preserves development identity", () => {
    process.env.VITE_DEV_SERVER_URL = "http://localhost:5734";
    delete process.env.BIGBUD_HOME;
    delete process.env.T3CODE_HOME;

    const config = resolveDesktopMainConfig(
      appForVersion("0.0.0-dev", false),
      "/repo/apps/desktop/dist",
    );

    expect(config.appDisplayName).toBe("bigbud (Dev)");
    expect(config.userDataDirName).toBe("bigbud-dev");
    expect(config.baseDir).toBe(Path.join(OS.homedir(), ".bigbud"));
    expect(config.cuaDriverHostBundleId).toBe("ai.bigbud.desktop.dev");
    // Development never reads the installed app's userdata settings.
    expect(config.serverSettingsPath).toBe(
      Path.join(OS.homedir(), ".bigbud", "dev", "settings.json"),
    );
    expect(config.computerUseDevelopmentRoot).toBe(
      Path.join(OS.homedir(), ".bigbud", "dev", "computer-use"),
    );
    // The legacy Cua runtime resolves under the dev state root, not the installed app's.
    expect(config.cuaDriverBaseDir).toBe(Path.join(OS.homedir(), ".bigbud", "dev"));
  });

  it("keeps packaged settings and computer-use roots unchanged", () => {
    delete process.env.VITE_DEV_SERVER_URL;
    delete process.env.BIGBUD_HOME;
    delete process.env.T3CODE_HOME;

    const config = resolveDesktopMainConfig(appForVersion("1.2.3"), "/repo/apps/desktop/dist");

    expect(config.serverSettingsPath).toBe(
      Path.join(OS.homedir(), ".bigbud", "userdata", "settings.json"),
    );
    expect(config.computerUseDevelopmentRoot).toBeNull();
    // Packaged keeps the Cua runtime exactly at `<baseDir>/runtime/cua-driver`.
    expect(config.cuaDriverBaseDir).toBe(config.baseDir);
    expect(config.cuaDriverBaseDir).toBe(Path.join(OS.homedir(), ".bigbud"));
  });

  it.each(["1.2.3-beta.1", "1.2.3-nightly.1"])(
    "keeps the packaged Cua runtime base on the channel base for %s",
    (version) => {
      delete process.env.VITE_DEV_SERVER_URL;
      delete process.env.BIGBUD_HOME;
      delete process.env.T3CODE_HOME;

      const config = resolveDesktopMainConfig(appForVersion(version), "/repo/apps/desktop/dist");

      expect(config.cuaDriverBaseDir).toBe(config.baseDir);
    },
  );

  it("derives the development roots from BIGBUD_HOME", () => {
    process.env.VITE_DEV_SERVER_URL = "http://localhost:5734";
    delete process.env.T3CODE_HOME;
    process.env.BIGBUD_HOME = "/tmp/exact-bigbud-home";

    const config = resolveDesktopMainConfig(
      appForVersion("0.0.0-dev", false),
      "/repo/apps/desktop/dist",
    );

    expect(config.serverSettingsPath).toBe("/tmp/exact-bigbud-home/dev/settings.json");
    expect(config.computerUseDevelopmentRoot).toBe("/tmp/exact-bigbud-home/dev/computer-use");
    expect(config.cuaDriverBaseDir).toBe("/tmp/exact-bigbud-home/dev");
  });

  it("keeps a packaged BIGBUD_HOME override as the Cua runtime base", () => {
    delete process.env.VITE_DEV_SERVER_URL;
    delete process.env.T3CODE_HOME;
    process.env.BIGBUD_HOME = "/tmp/exact-bigbud-home";

    const config = resolveDesktopMainConfig(appForVersion("1.2.3"), "/repo/apps/desktop/dist");

    expect(config.cuaDriverBaseDir).toBe("/tmp/exact-bigbud-home");
  });
});
