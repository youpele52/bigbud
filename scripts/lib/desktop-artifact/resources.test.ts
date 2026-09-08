import { assert, describe, it } from "vitest";
import { Effect } from "effect";
import { desktopReleaseIdentityForChannel } from "@bigbud/shared/desktopReleaseIdentity";

import { pickExternalDependencies } from "./build.runtime.ts";
import { createBuildConfig, resolveDesktopRuntimeDependencies } from "./resources.ts";

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
        createBuildConfig("win", "nsis", identity, false, true, "3000", "/resources", "/repo"),
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
    },
  );

  it("requires signing and explicitly signs the Rust sidecar for signed macOS builds", async () => {
    const config = await Effect.runPromise(
      createBuildConfig(
        "mac",
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
      binaries: [
        "Contents/Resources/server/workspace-agent/bin/bigbud-remote-agent",
        "Contents/Resources/server/delivery-supervisor/bin/bigbud-desktop-supervisor",
      ],
      entitlements: "/resources/entitlements.mac.plist",
      entitlementsInherit: "/resources/entitlements.mac.plist",
    });
    assert.equal(config.afterSign, "/repo/apps/desktop/scripts/notarize.cjs");
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
