import { assert, describe, it } from "vitest";

import { pickExternalDependencies } from "./build.runtime.ts";
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
