import { afterEach, describe, expect, it } from "vitest";

import { makeConfiguredRemoteAgentLayers } from "./remoteAgentServerLayer.ts";
import { closeConfiguredRemoteAgentCompositions } from "./remoteAgentDefault.ts";

const originalBinary = process.env.BIGBUD_REMOTE_AGENT_BINARY;
const originalTransport = process.env.BIGBUD_REMOTE_AGENT_TRANSPORT;

afterEach(() => {
  if (originalBinary === undefined) delete process.env.BIGBUD_REMOTE_AGENT_BINARY;
  else process.env.BIGBUD_REMOTE_AGENT_BINARY = originalBinary;
  if (originalTransport === undefined) delete process.env.BIGBUD_REMOTE_AGENT_TRANSPORT;
  else process.env.BIGBUD_REMOTE_AGENT_TRANSPORT = originalTransport;
  closeConfiguredRemoteAgentCompositions();
});

describe("configured remote agent server layer", () => {
  it("enables the managed remote agent path by default", () => {
    delete process.env.BIGBUD_REMOTE_AGENT_BINARY;
    delete process.env.BIGBUD_REMOTE_AGENT_TRANSPORT;
    expect(makeConfiguredRemoteAgentLayers().enabled).toBe(true);
  });

  it("accepts an explicit agent binary without starting a connection", () => {
    process.env.BIGBUD_REMOTE_AGENT_BINARY = "$HOME/.bigbud/agent/bin/current";
    expect(makeConfiguredRemoteAgentLayers().enabled).toBe(true);
  });

  it("retains direct ssh as an explicit diagnostic fallback", () => {
    process.env.BIGBUD_REMOTE_AGENT_TRANSPORT = "direct-ssh";
    expect(makeConfiguredRemoteAgentLayers().enabled).toBe(false);
  });
});
