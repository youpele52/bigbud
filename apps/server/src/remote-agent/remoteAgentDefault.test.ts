import { describe, expect, it } from "vitest";

import {
  DEFAULT_REMOTE_AGENT_BINARY,
  resolveRemoteAgentConfiguration,
} from "./remoteAgentDefault.ts";

describe("remote agent default configuration", () => {
  it("uses the managed active binary when no override is present", () => {
    expect(resolveRemoteAgentConfiguration({})).toEqual({
      transport: "agent",
      binaryPath: DEFAULT_REMOTE_AGENT_BINARY,
    });
  });

  it("supports an explicit direct ssh fallback", () => {
    expect(
      resolveRemoteAgentConfiguration({ BIGBUD_REMOTE_AGENT_TRANSPORT: "direct-ssh" }),
    ).toEqual({ transport: "direct-ssh", binaryPath: null });
  });

  it("rejects unknown transport modes", () => {
    expect(() =>
      resolveRemoteAgentConfiguration({ BIGBUD_REMOTE_AGENT_TRANSPORT: "automatic" }),
    ).toThrow("must be either 'agent' or 'direct-ssh'");
  });
});
