import type { CliProxyVersion } from "@bigbud/contracts/server/server.providers.ts";
import { describe, expect, it } from "vitest";

import { cliProxyUpdateMessage } from "./CliProxyVersionNotice.logic";

const version: CliProxyVersion = {
  recommendedVersion: "8.0.51",
  runtimeVersion: null,
  installedVersion: "8.0.30",
  installation: "unknown",
};

describe("CLIProxyAPI recommendation copy", () => {
  it("identifies installed-only evidence without claiming the running version", () => {
    const message = cliProxyUpdateMessage({ ...version, updateSource: "installed" });
    expect(message).toContain("installed CLIProxyAPI binary");
    expect(message).toContain("connected server version could not be verified and may differ");
    expect(message).toContain("Older versions remain usable");
  });

  it("labels evidenced runtime versions separately", () => {
    const message = cliProxyUpdateMessage({
      ...version,
      runtimeVersion: "8.0.30",
      updateSource: "runtime",
    });
    expect(message).toContain("connected CLIProxyAPI server reports 8.0.30");
    expect(message).not.toContain("installed CLIProxyAPI binary");
  });

  it("does not invent a warning for unknown, current or newer snapshots", () => {
    for (const runtimeVersion of [null, "8.0.51", "8.0.100", "dev"]) {
      expect(cliProxyUpdateMessage({ ...version, runtimeVersion })).toBeNull();
    }
    expect(cliProxyUpdateMessage({ ...version, updateSource: "runtime" })).toBeNull();
  });
});
