import { describe, expect, it } from "vitest";

import {
  parseRemoteAgentPlatformProbe,
  RemoteAgentPlatformProbeError,
} from "./remoteAgentPlatform.ts";

describe("remote agent platform probe", () => {
  it("normalizes supported Linux platform output", () => {
    expect(parseRemoteAgentPlatformProbe("Linux\naarch64\n")).toEqual({
      operatingSystem: "linux",
      architecture: "aarch64",
      targetTriple: "aarch64-unknown-linux-gnu",
    });
  });

  it("returns no artifact target for unsupported platforms", () => {
    expect(parseRemoteAgentPlatformProbe("Darwin\narm64\n").targetTriple).toBeNull();
  });

  it("rejects incomplete probe output", () => {
    expect(() => parseRemoteAgentPlatformProbe("Linux\n")).toThrow(RemoteAgentPlatformProbeError);
  });
});
