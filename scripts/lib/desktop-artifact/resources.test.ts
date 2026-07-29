import { assert, describe, it } from "vitest";

import { resolveDesktopRuntimeDependencies } from "./resources.ts";

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
