import { describe, expect, it } from "vitest";

import {
  buildRemoteAgentPresenceProbeCommand,
  buildRemoteAgentProxyCommand,
} from "./remoteAgentConnection.ts";

describe("remote agent proxy command", () => {
  it("starts a same-user supervisor and connects through its socket", () => {
    const command = buildRemoteAgentProxyCommand("/tmp/agent's binary");
    expect(command).toContain("/tmp/agent'\\''s binary");
    expect(command).toContain("--supervisor");
    expect(command).toContain("--proxy");
    expect(command).toContain('socket="$HOME/.bigbud/agent/state/supervisor.sock"');
    expect(command).toContain('cat "$log" >&2');
  });

  it("expands the supported installed-binary home path remotely", () => {
    expect(
      buildRemoteAgentProxyCommand("$HOME/.bigbud/agent/bin/0.1.0/bigbud-remote-agent"),
    ).toContain('"$HOME/.bigbud/agent/bin/0.1.0/bigbud-remote-agent" --proxy');
    expect(buildRemoteAgentPresenceProbeCommand("$HOME/.bigbud/agent/bin/current")).toBe(
      "if test -x \"$HOME/.bigbud/agent/bin/current\"; then printf 'ready'; else printf 'missing'; fi",
    );
  });
});
