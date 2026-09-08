import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveWindowsUpdateTargets } from "./windowsUpdateTargets";

describe("resolveWindowsUpdateTargets", () => {
  it("inventories only executable targets evidenced by packaged runtime resolution", () => {
    const resourcesPath = String.raw`C:\Program Files\bigbud\resources`;
    expect(
      resolveWindowsUpdateTargets({
        cuaDriverPath: String.raw`C:\Users\me\.bigbud\runtime\cua-driver.exe`,
        isPackaged: true,
        platform: "win32",
        resourcesPath,
      }),
    ).toEqual([
      {
        label: "the CUA driver",
        path: String.raw`C:\Users\me\.bigbud\runtime\cua-driver.exe`,
      },
      {
        label: "the packaged OpenCode runtime",
        path: Path.join(resourcesPath, "server", "opencode", "bin", "opencode.exe"),
      },
      {
        label: "the packaged workspace agent",
        path: Path.join(
          resourcesPath,
          "server",
          "workspace-agent",
          "bin",
          "bigbud-remote-agent.exe",
        ),
      },
      {
        label: "the packaged desktop supervisor",
        path: Path.join(
          resourcesPath,
          "server",
          "delivery-supervisor",
          "bin",
          "bigbud-desktop-supervisor.exe",
        ),
      },
    ]);
  });

  it("omits packaged children outside packaged Windows builds", () => {
    expect(
      resolveWindowsUpdateTargets({
        cuaDriverPath: null,
        isPackaged: false,
        platform: "win32",
        resourcesPath: "/resources",
      }),
    ).toEqual([]);
    expect(
      resolveWindowsUpdateTargets({
        cuaDriverPath: "/cua-driver",
        isPackaged: true,
        platform: "darwin",
        resourcesPath: "/resources",
      }),
    ).toEqual([]);
  });
});
