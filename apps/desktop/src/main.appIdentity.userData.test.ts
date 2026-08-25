import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ existsSync: vi.fn(() => false) }));

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("electron", () => ({ app: {} }));
vi.mock("./env/pathResolver", () => ({ resolveAboutCommitHash: vi.fn() }));

import { resolveUserDataPath } from "./main.appIdentity";

const originalPlatform = process.platform;

describe("resolveUserDataPath", () => {
  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    mocks.existsSync.mockReset();
    mocks.existsSync.mockReturnValue(false);
  });

  it("allows Stable to retain the legacy Alpha profile", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    mocks.existsSync.mockReturnValue(true);

    const path = resolveUserDataPath({
      legacyUserDataDirName: "T3 Code (Alpha)",
      userDataDirName: "bigbud",
    });

    expect(path).toBe(Path.join(OS.homedir(), "Library", "Application Support", "T3 Code (Alpha)"));
  });

  it.each(["bigbud-beta", "bigbud-preview", "bigbud-nightly"])(
    "never captures the legacy profile for %s",
    (userDataDirName) => {
      Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
      mocks.existsSync.mockReturnValue(true);

      const path = resolveUserDataPath({ legacyUserDataDirName: null, userDataDirName });

      expect(path).toBe(Path.join(OS.homedir(), "Library", "Application Support", userDataDirName));
      expect(mocks.existsSync).not.toHaveBeenCalled();
    },
  );
});
