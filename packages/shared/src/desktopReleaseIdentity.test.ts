import { describe, expect, it } from "vitest";

import {
  desktopReleaseIdentityForChannel,
  resolveDesktopReleaseIdentity,
} from "./desktopReleaseIdentity";

describe("desktop release identity", () => {
  it.each([
    ["stable", "1.2.3", "ai.bigbud.desktop", "bigbud", "bigbud", [], "latest"],
    [
      "beta",
      "1.2.3-beta.1",
      "ai.bigbud.desktop.beta",
      "bigbud Beta",
      "bigbud-beta",
      ["channels", "beta"],
      "beta",
    ],
    [
      "preview",
      "1.2.3-preview.1",
      "ai.bigbud.desktop.preview",
      "bigbud Preview",
      "bigbud-preview",
      ["channels", "preview"],
      "preview",
    ],
    [
      "nightly",
      "1.2.3-nightly.20260824",
      "ai.bigbud.desktop.nightly",
      "bigbud Nightly",
      "bigbud-nightly",
      ["channels", "nightly"],
      "nightly",
    ],
  ] as const)(
    "resolves the %s identity",
    (channel, version, appId, productName, executableName, baseDirSuffix, updaterChannel) => {
      const identity = resolveDesktopReleaseIdentity(version);
      expect(identity).toBe(desktopReleaseIdentityForChannel(channel));
      expect(identity).toMatchObject({
        appId,
        appUserModelId: appId,
        baseDirSuffix,
        executableName,
        linuxDesktopEntryName: `${executableName}.desktop`,
        linuxWmClass: executableName,
        packageName: channel === "stable" ? "bigbud-desktop" : `bigbud-desktop-${channel}`,
        productName,
        updaterChannel,
        userDataDirName: executableName,
      });
    },
  );

  it.each(["1.2.3-alpha.1", "1.2.3.rc.1", "dev"])("rejects unsupported version %s", (version) => {
    expect(() => resolveDesktopReleaseIdentity(version)).toThrow(
      `Unsupported desktop release version: ${version}`,
    );
  });
});
