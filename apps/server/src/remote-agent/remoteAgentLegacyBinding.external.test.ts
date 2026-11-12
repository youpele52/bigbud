import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentHello } from "./remoteAgentProtocol.ts";
import { observeLegacyRemoteAgentBinding } from "./remoteAgentLegacyBinding.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { buildRemoteAgentRuntimeProbeCommand } from "./remoteAgentConnection.identity.ts";
import { buildPinnedRemoteAgentProxy } from "./remoteAgentRuntime.launch.ts";

const sha256 = "a".repeat(64);
const path = "/opt/custom agent/bin/agent";
function fixture() {
  let state = emptyRemoteAgentRegistry();
  const run = vi.fn(
    async () => `${path}\n${sha256}\nbigbud-remote-agent 0.2.207 1 5 fixture linux aarch64\n`,
  );
  const control = {
    root: "/home/test/.bigbud/agent",
    run,
    registry: {
      read: async () => state,
      update: async (change) => {
        state = parseRemoteAgentRegistry(JSON.stringify(change(state)));
        return state;
      },
    } as RemoteAgentControl["registry"],
  } satisfies RemoteAgentControl;
  const connection = Object.create(RemoteAgentConnection.prototype) as RemoteAgentConnection;
  const hello: { -readonly [K in keyof RemoteAgentHello]: RemoteAgentHello[K] } = {
    protocolMajor: 1,
    protocolMinor: 5,
    agentVersion: "0.2.207",
    buildDigest: "fixture",
    os: "linux",
    architecture: "aarch64",
    agentInstanceId: "instance",
    agentEpoch: "epoch-1",
    capabilities: ["terminal.pty", "workspace.files", "terminal.shell-profiles"].map((name) => ({
      name,
      major: 1,
      minor: 0,
    })),
    maxFrameBytes: 1024,
    maxOperationOutputBytes: 1024,
    maxJournalBytes: 1024,
  };
  connection.handshake = vi.fn(async () => hello);
  connection.close = vi.fn();
  connection.request = vi.fn(async () => ({
    type: "diagnosticResponse" as const,
    value: {
      requestId: "ignored",
      operationId: "ignored",
      accepted: true,
      terminal: true,
      message: "agent-ready",
    },
  }));
  const connect = vi.fn(async () => connection);
  const observe = () =>
    observeLegacyRemoteAgentBinding("target", control, connect, undefined, path);
  return { control, run, connection, hello, connect, observe };
}

beforeEach(() => vi.restoreAllMocks());
describe("custom binary profile runtime observation", () => {
  it("pins external bytes/account state/epoch without selecting or authenticating a managed admission", async () => {
    const f = fixture();
    const binding = await f.observe();
    expect(binding).toMatchObject({
      runtime: {
        origin: "legacy-external",
        binaryPath: path,
        sha256,
        statePath: "/home/test/.bigbud/agent/state",
      },
      expectedEpoch: "epoch-1",
    });
    const state = await f.control.registry.read();
    expect(state.current).toBeNull();
    expect(state.currentConnectionId).toBeNull();
    expect(state.builds).toHaveLength(1);
    expect(state.builds[0]).toMatchObject({ health: "staged", authenticated: false });
    expect(state.launches[0]).toMatchObject({ phase: "ready", epoch: "epoch-1" });
    expect(f.connect).toHaveBeenCalledWith(binding?.runtime);
    const proxy = buildPinnedRemoteAgentProxy(binding!.runtime);
    expect(proxy).toContain(sha256);
    expect(proxy).toContain("sha256sum -- '/opt/custom agent/bin/agent'");
    expect(proxy).toContain("--proxy");
    expect(proxy).not.toMatch(/--(?:prepare|restart|shutdown|supervisor)/);
    expect(f.connection.close).toHaveBeenCalledTimes(1);
    await f.observe();
    expect((await f.control.registry.read()).builds).toHaveLength(1);
  });

  it("does not overwrite another selected runtime or target admission", async () => {
    const f = fixture();
    const observed = await f.observe();
    const id = (await f.control.registry.read()).builds[0]!.id;
    await f.control.registry.update((state) => ({ ...state, current: id }));
    await f.observe();
    expect((await f.control.registry.read()).current).toBe(id);
    expect((await f.control.registry.read()).admissions).toEqual([]);
    expect(observed?.runtime.origin).toBe("legacy-external");
  });

  it.each(["capability", "identity", "readiness"])(
    "fails closed before registry mutation for %s mismatch",
    async (failure) => {
      const f = fixture();
      if (failure === "capability")
        f.hello.capabilities = f.hello.capabilities.filter(
          (capability) => capability.name !== "terminal.shell-profiles",
        );
      if (failure === "identity") f.hello.buildDigest = "another-build";
      if (failure === "readiness")
        vi.mocked(f.connection.request).mockRejectedValue(new Error("unavailable"));
      await expect(f.observe()).rejects.toThrow();
      expect((await f.control.registry.read()).builds).toEqual([]);
      expect(f.connection.close).toHaveBeenCalledTimes(1);
    },
  );

  it("retains the old descriptor after changed path or epoch rather than rebinding possible live work", async () => {
    const f = fixture();
    const binding = await f.observe();
    f.hello.agentEpoch = "epoch-2";
    await expect(f.observe()).rejects.toThrow("epoch changed");
    f.hello.agentEpoch = "epoch-1";
    f.run.mockResolvedValue(
      `/opt/replaced\n${sha256}\nbigbud-remote-agent 0.2.207 1 5 fixture linux aarch64\n`,
    );
    await expect(f.observe()).rejects.toThrow("descriptor changed");
    expect((await f.control.registry.read()).builds[0]?.runtime).toEqual(binding?.runtime);
    expect((await f.control.registry.read()).launches[0]?.epoch).toBe("epoch-1");
  });

  it("reports a missing custom binary without connecting or using managed current", async () => {
    const f = fixture();
    f.run.mockResolvedValue("missing");
    expect(await f.observe()).toBeUndefined();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("quotes custom paths as data and permits only the existing safe HOME form", () => {
    expect(buildRemoteAgentRuntimeProbeCommand("/tmp/agent'; touch /tmp/unwanted")).toContain(
      "binary='/tmp/agent'\\''; touch /tmp/unwanted'",
    );
    expect(buildRemoteAgentRuntimeProbeCommand("$HOME/bin/agent")).toContain(
      'binary="$HOME/bin/agent"',
    );
    expect(buildRemoteAgentRuntimeProbeCommand("$HOME/$(touch unwanted)")).toContain(
      "binary='$HOME/$(touch unwanted)'",
    );
  });
});
