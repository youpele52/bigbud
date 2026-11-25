import { describe, expect, it } from "vitest";

import { sshConfigHostHint } from "./SidebarRemoteWorkspaceDialog.sshConfigHint";

describe("sshConfigHostHint", () => {
  it("shows destination, login, port and route", () => {
    expect(
      sshConfigHostHint({
        alias: "work-server",
        sourcePath: "~/.ssh/config",
        line: 12,
        hostName: "::1",
        user: "picker",
        port: "2222",
        hostKeyAlias: "work-trust",
        route: "via 1 hop",
      }),
    ).toBe("::1 · user picker · port 2222 · via 1 hop");
  });

  it("falls back to whatever was resolved and never adds a credential path", () => {
    expect(
      sshConfigHostHint({ alias: "gpu-box", sourcePath: "~/.ssh/config.d/lab", line: 3 }),
    ).toBe("");
    expect(
      sshConfigHostHint({
        alias: "gpu-box",
        sourcePath: "~/.ssh/config.d/lab",
        line: 3,
        hostName: "gpu.internal",
        route: "direct",
      }),
    ).toBe("gpu.internal · direct");
  });
});
