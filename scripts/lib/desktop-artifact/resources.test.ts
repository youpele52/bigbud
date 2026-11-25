import { assert, describe, it } from "vitest";
import { Effect } from "effect";
import { desktopReleaseIdentityForChannel } from "@bigbud/shared/desktopReleaseIdentity";

import { isOffArchMacNativeDirectory, pickExternalDependencies } from "./build.runtime.ts";
import { join } from "node:path";
import {
  DESKTOP_NSIS_INCLUDE,
  createBuildConfig,
  resolveDesktopRuntimeDependencies,
} from "./resources.ts";

describe("resolveDesktopRuntimeDependencies", () => {
  it("keeps installable runtime dependencies and resolves catalog entries", () => {
    assert.deepEqual(
      resolveDesktopRuntimeDependencies(
        {
          effect: "catalog:",
          "electron-updater": "6.8.3",
        },
        {
          effect: "4.0.0-beta.43",
        },
      ),
      {
        effect: "4.0.0-beta.43",
        "electron-updater": "6.8.3",
      },
    );
  });

  it("excludes build-time workspace packages and Electron from the staged manifest", () => {
    assert.deepEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@bigbud/shared": "workspace:*",
          electron: "40.6.0",
          "electron-updater": "6.8.3",
        },
        {},
      ),
      {
        "electron-updater": "6.8.3",
      },
    );
  });
});

describe("createBuildConfig", () => {
  it.each(["stable", "beta", "preview", "nightly"] as const)(
    "uses the %s identity across platform configuration",
    async (channel) => {
      const identity = desktopReleaseIdentityForChannel(channel);
      const linux = await Effect.runPromise(
        createBuildConfig(
          "linux",
          "x64",
          "AppImage",
          identity,
          false,
          true,
          "3000",
          "/resources",
          "/repo",
        ),
      );
      const windows = await Effect.runPromise(
        createBuildConfig(
          "win",
          "x64",
          "nsis",
          identity,
          false,
          true,
          "3000",
          "/resources",
          "/repo",
        ),
      );

      assert.equal(linux.appId, identity.appId);
      assert.equal(linux.productName, identity.productName);
      assert.equal(linux.artifactName, "bigbud-${version}-${arch}.${ext}");
      assert.deepInclude(linux.linux, {
        executableName: identity.executableName,
        desktop: { entry: { StartupWMClass: identity.linuxWmClass } },
      });
      assert.equal(
        (linux.publish as ReadonlyArray<{ readonly channel: string }>)[0]?.channel,
        identity.updaterChannel,
      );
      assert.equal(windows.appId, identity.appId);
      assert.equal(windows.productName, identity.productName);
      assert.notProperty(windows.win as object, "azureSignOptions");
      assert.deepInclude(windows.win, { signExts: [".exe"] });
      assert.deepEqual(windows.nsis, { include: join("/repo", DESKTOP_NSIS_INCLUDE) });
      assert.notProperty(linux, "nsis");
      assert.notProperty(linux, "dmg");
      assert.notProperty(windows, "dmg");
    },
  );

  it.each(["arm64", "x64"] as const)(
    "signs the expected Rust sidecars for macOS %s",
    async (arch) => {
      const config = await Effect.runPromise(
        createBuildConfig(
          "mac",
          arch,
          "dmg",
          desktopReleaseIdentityForChannel("preview"),
          true,
          false,
          undefined,
          "/resources",
          "/repo",
        ),
      );

      assert.equal(config.forceCodeSigning, true);
      assert.deepInclude(config.mac, {
        notarize: false,
        binaries: [
          "Contents/Resources/server/workspace-agent/bin/bigbud-remote-agent",
          "Contents/Resources/server/delivery-supervisor/bin/bigbud-desktop-supervisor",
          ...(arch === "arm64" ? ["Contents/Resources/server/ssh-owner/bin/bigbud-ssh-owner"] : []),
        ],
        entitlements: "/resources/entitlements.mac.plist",
        entitlementsInherit: "/resources/entitlements.mac.plist",
      });
      assert.equal(config.afterSign, "/repo/apps/desktop/scripts/notarize.cjs");
      assert.deepEqual(config.dmg, { format: "ULFO", writeUpdateInfo: false });
      assert.deepEqual((config.mac as { target: unknown }).target, ["dmg", "zip"]);
      assert.deepInclude((config.mac as { extendInfo: object }).extendInfo, {
        NSCameraUsageDescription:
          "bigbud uses your camera only when you allow a browser site to access it.",
        NSMicrophoneUsageDescription:
          "bigbud uses your microphone for voice input and browser sites you explicitly allow.",
        NSLocationWhenInUseUsageDescription:
          "bigbud shares your location only with browser sites you explicitly allow.",
        NSDocumentsFolderUsageDescription:
          "bigbud searches and opens files in Documents only when your File Access setting includes it.",
        NSDownloadsFolderUsageDescription:
          "bigbud searches and opens files in Downloads only when your File Access setting includes it.",
        NSDesktopFolderUsageDescription:
          "bigbud searches and opens files on the Desktop only when your File Access setting includes it.",
      });
    },
  );
});

describe("isOffArchMacNativeDirectory", () => {
  it("prunes only the other macOS architecture's native directories", () => {
    for (const name of ["darwin-arm64", "msgpackr-extract-darwin-arm64", "koffi-darwin-arm64"])
      assert.isTrue(isOffArchMacNativeDirectory(name, "x64"), name);
    assert.isTrue(isOffArchMacNativeDirectory("darwin-x64", "arm64"));
    for (const name of ["darwin-x64", "darwin-universal", "darwin", "copilot-darwin-x64"])
      assert.isFalse(isOffArchMacNativeDirectory(name, "x64"), name);
    assert.isFalse(isOffArchMacNativeDirectory("darwin-arm64", "universal"));
  });
});

describe("pickExternalDependencies", () => {
  it("keeps the exact Copilot CLI runtime alongside its SDK", () => {
    assert.deepEqual(
      pickExternalDependencies({
        "@github/copilot": "1.0.73",
        "@github/copilot-sdk": "1.0.7",
        effect: "4.0.0-beta.43",
      }),
      {
        "@github/copilot": "1.0.73",
        "@github/copilot-sdk": "1.0.7",
      },
    );
  });
});
