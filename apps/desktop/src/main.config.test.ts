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
  });
});
