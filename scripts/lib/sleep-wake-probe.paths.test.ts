import path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultStateDir, packagedUserDataPath } from "./sleep-wake-probe.paths.ts";

const HOME = "/home/tester";
const none = () => false;
const legacyExists = (candidate: string) => candidate.endsWith("T3 Code (Alpha)");

describe("packaged desktop paths", () => {
  it("mirrors Electron userData per platform and channel", () => {
    expect(packagedUserDataPath("stable", "darwin", {}, HOME, none)).toBe(
      path.join(HOME, "Library", "Application Support", "bigbud"),
    );
    expect(packagedUserDataPath("beta", "linux", { XDG_CONFIG_HOME: "/xdg" }, HOME, none)).toBe(
      path.join("/xdg", "bigbud-beta"),
    );
    expect(packagedUserDataPath("stable", "linux", {}, HOME, none)).toBe(
      path.join(HOME, ".config", "bigbud"),
    );
    expect(packagedUserDataPath("nightly", "win32", { APPDATA: "C:/AppData" }, HOME, none)).toBe(
      path.join("C:/AppData", "bigbud-nightly"),
    );
  });

  it("keeps the legacy stable profile when it exists, never for prerelease channels", () => {
    expect(packagedUserDataPath("stable", "darwin", {}, HOME, legacyExists)).toBe(
      path.join(HOME, "Library", "Application Support", "T3 Code (Alpha)"),
    );
    expect(packagedUserDataPath("beta", "darwin", {}, HOME, legacyExists)).toBe(
      path.join(HOME, "Library", "Application Support", "bigbud-beta"),
    );
  });

  it("puts prerelease state under channels/<channel>", () => {
    expect(defaultStateDir("packaged", "preview")).toSatisfy((dir: string) =>
      dir.endsWith(path.join("channels", "preview", "userdata")),
    );
    expect(defaultStateDir("dev")).toSatisfy((dir: string) => dir.endsWith(`${path.sep}dev`));
  });
});
