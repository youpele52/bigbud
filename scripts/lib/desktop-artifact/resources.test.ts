import { assert, describe, it } from "vitest";

import { resolveDesktopRuntimeDependencies, resolveMacAdditionalBinaries } from "./resources.ts";

describe("resolveDesktopRuntimeDependencies", () => {
  it("keeps installable runtime dependencies and resolves catalog entries", () => {
    assert.deepEqual(
      resolveDesktopRuntimeDependencies(
        {
          effect: "catalog:",
          "electron-updater": "^6.6.2",
        },
        {
          effect: "4.0.0-beta.43",
        },
      ),
      {
        effect: "4.0.0-beta.43",
        "electron-updater": "^6.6.2",
      },
    );
  });

  it("excludes build-time workspace packages and Electron from the staged manifest", () => {
    assert.deepEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@bigbud/shared": "workspace:*",
          electron: "40.6.0",
          "electron-updater": "^6.6.2",
        },
        {},
      ),
      {
        "electron-updater": "^6.6.2",
      },
    );
  });
});

describe("resolveMacAdditionalBinaries", () => {
  it.each(["arm64", "x64"] as const)(
    "includes the staged Copilot MediaRemote framework for %s",
    (arch) => {
      assert.deepEqual(resolveMacAdditionalBinaries(arch), [
        `Contents/Resources/server/_modules/@github/copilot-darwin-${arch}/prebuilds/darwin-${arch}/mediaremote-adapter/MediaRemoteAdapter.framework/MediaRemoteAdapter`,
      ]);
    },
  );

  it("includes both staged framework executables for universal builds", () => {
    assert.deepEqual(resolveMacAdditionalBinaries("universal"), [
      "Contents/Resources/server/_modules/@github/copilot-darwin-arm64/prebuilds/darwin-arm64/mediaremote-adapter/MediaRemoteAdapter.framework/MediaRemoteAdapter",
      "Contents/Resources/server/_modules/@github/copilot-darwin-x64/prebuilds/darwin-x64/mediaremote-adapter/MediaRemoteAdapter.framework/MediaRemoteAdapter",
    ]);
  });
});
