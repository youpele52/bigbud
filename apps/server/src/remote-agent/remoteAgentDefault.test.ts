import { describe, expect, it } from "vitest";

import {
  DEFAULT_REMOTE_AGENT_BINARY,
  isRemoteAgentExecutionTarget,
  resolveRemoteAgentConfiguration,
  resolveRemoteAgentTransport,
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
    ).toEqual({ transport: "direct-ssh", binaryPath: DEFAULT_REMOTE_AGENT_BINARY });
  });

  it("rejects unknown transport modes", () => {
    expect(() =>
      resolveRemoteAgentConfiguration({ BIGBUD_REMOTE_AGENT_TRANSPORT: "automatic" }),
    ).toThrow("must be either 'agent' or 'direct-ssh'");
  });

  it("allows each SSH target to override the process default", () => {
    const environment = { BIGBUD_REMOTE_AGENT_TRANSPORT: "direct-ssh" };
    const agentTarget = "ssh:host=agent-host&transport=agent";
    const directTarget = "ssh:host=direct-host&transport=direct-ssh";

    expect(resolveRemoteAgentTransport(agentTarget, environment)).toBe("agent");
    expect(resolveRemoteAgentTransport(directTarget, environment)).toBe("direct-ssh");
    expect(isRemoteAgentExecutionTarget(agentTarget, environment)).toBe(true);
    expect(isRemoteAgentExecutionTarget(directTarget, environment)).toBe(false);
  });

  it("does not classify the local target as a remote-agent target", () => {
    expect(isRemoteAgentExecutionTarget("local", { BIGBUD_REMOTE_AGENT_TRANSPORT: "agent" })).toBe(
      false,
    );
  });
});
