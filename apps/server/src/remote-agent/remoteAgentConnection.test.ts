import { describe, expect, it, vi } from "vitest";

import {
  buildRemoteAgentIdentityProbeCommand,
  buildRemoteAgentProxyCommand,
  closeRemoteAgentProcess,
  remoteAgentLocalProcessArgs,
} from "./remoteAgentConnection.ts";

describe("remote agent proxy command", () => {
  it("starts a same-user supervisor and connects through its socket", () => {
    const command = buildRemoteAgentProxyCommand("/tmp/agent's binary");
    expect(command).toContain("/tmp/agent'\\''s binary");
    expect(command).toContain("--supervisor");
    expect(command).toContain("--prepare-supervisor");
    expect(command).toContain("--proxy");
    expect(command).toContain('socket="$HOME/.bigbud/agent/state/supervisor.sock"');
    expect(command).toContain('cat "$log" >&2');
  });

  it("expands the supported installed-binary home path remotely", () => {
    expect(
      buildRemoteAgentProxyCommand("$HOME/.bigbud/agent/bin/0.1.0/bigbud-remote-agent"),
    ).toContain('"$HOME/.bigbud/agent/bin/0.1.0/bigbud-remote-agent" --proxy');
    expect(buildRemoteAgentIdentityProbeCommand("$HOME/.bigbud/agent/bin/current")).toBe(
      'if test -x "$HOME/.bigbud/agent/bin/current"; then exec "$HOME/.bigbud/agent/bin/current" --check; else printf \'missing\'; fi',
    );
  });
});

describe("local remote agent process", () => {
  it("accepts explicit ephemeral arguments", () => {
    expect(remoteAgentLocalProcessArgs({ args: ["--ephemeral"] })).toEqual(["--ephemeral"]);
    expect(remoteAgentLocalProcessArgs({ mode: "proxy" })).toEqual(["--proxy"]);
  });

  it("closes the Windows process tree before falling back to direct termination", () => {
    const end = vi.fn();
    const kill = vi.fn(() => true);
    const taskkill = vi.fn(() => ({ status: 0 }));
    closeRemoteAgentProcess(
      { pid: 42, stdin: { end }, kill },
      { platform: "win32", taskkill: taskkill as never },
    );
    expect(end).toHaveBeenCalledOnce();
    expect(taskkill).toHaveBeenCalledWith("taskkill", ["/pid", "42", "/T", "/F"], {
      stdio: "ignore",
    });
    expect(kill).not.toHaveBeenCalled();
  });
});
