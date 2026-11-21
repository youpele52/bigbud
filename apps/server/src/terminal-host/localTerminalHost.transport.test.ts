import { describe, expect, it } from "vitest";

import type {
  RemoteAgentConnection,
  RemoteAgentLocalProcessInput,
} from "../remote-agent/remoteAgentConnection.ts";
import { RemoteAgentConnectionPool } from "../remote-agent/remoteAgentConnectionPool.ts";
import { validateRemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import {
  LOCAL_TERMINAL_HOST_TARGET_ID,
  localTerminalHostGenerationPaths,
} from "./localTerminalHost.paths.ts";
import { fakeHostHello } from "./localTerminalHost.testUtils.ts";
import {
  localTerminalHostBinding,
  makeLocalTerminalHostTransportFactory,
  normalizeLocalTerminalHostHello,
  type LocalTerminalHostHello,
} from "./localTerminalHost.transport.ts";

const root = "/tmp/bbth-t/terminal-host";
const generation1 = localTerminalHostGenerationPaths(root, 1);
const generation2 = localTerminalHostGenerationPaths(root, 2);
const hello1 = fakeHostHello({ agentEpoch: "epoch-g1", buildDigest: "digest-a" });
const hello2 = fakeHostHello({ agentEpoch: "epoch-g2", buildDigest: "digest-b" });
const binding1 = localTerminalHostBinding(generation1, hello1, `${root}/runtimes/digest-a/agent`);
const binding2 = localTerminalHostBinding(generation2, hello2, `${root}/runtimes/digest-b/agent`);

/** A fake proxy connection answering with the hello of the generation its env names. */
function fakeConnect(hellos: Record<string, LocalTerminalHostHello>) {
  const dialed: Array<RemoteAgentLocalProcessInput> = [];
  const connect = (input: RemoteAgentLocalProcessInput) => {
    dialed.push(input);
    const hello = hellos[input.env?.BIGBUD_AGENT_STATE_DIR ?? ""];
    let closed = false;
    return {
      handshake: async () => {
        if (!hello) throw new Error("no host");
        return hello;
      },
      onFailure: () => () => {},
      supportsCapability: (name: string) =>
        hello?.capabilities.some((capability) => capability.name === name) ?? false,
      close: () => {
        closed = true;
      },
      get closed() {
        return closed;
      },
    } as unknown as RemoteAgentConnection;
  };
  return { connect, dialed };
}

describe("local terminal host transport", () => {
  it("binds a generation from its hello as a durable legacy-external runtime", () => {
    expect(binding1.connectionId).toBe("state-1");
    expect(binding1.expectedEpoch).toBe("epoch-g1");
    expect(binding1.runtime).toMatchObject({
      generation: "state-1",
      buildDigest: "digest-a",
      origin: "legacy-external",
      socketPath: `${root}/state-1/supervisor.sock`,
    });
    // Owner rows re-validate the runtime on every read.
    expect(validateRemoteAgentRuntime(binding1.runtime)).toEqual(binding1.runtime);
    expect(binding2.runtime.sha256).not.toBe(binding1.runtime.sha256);
  });

  it("rejects a hello from another platform before presenting the pool shape", () => {
    expect(normalizeLocalTerminalHostHello(hello1).os).toBe("linux");
    expect(() => normalizeLocalTerminalHostHello({ ...hello1, os: "plan9" })).toThrow(
      "platform differs",
    );
  });

  it("addresses only local-terminal-host and requires a generation binding", async () => {
    const factory = makeLocalTerminalHostTransportFactory({
      resolveBinding: async () => binding2,
      proxyBinary: async () => "/staged/agent",
      assertSocket: async () => {},
    });
    await expect(factory.create("ssh:host", binding1)).rejects.toThrow("another target");
    await expect(factory.create(LOCAL_TERMINAL_HOST_TARGET_ID)).rejects.toThrow("generation");
  });

  it("dials through the currently staged proxy and refuses insecure sockets", async () => {
    const { connect, dialed } = fakeConnect({ [generation1.statePath]: hello1 });
    const factory = makeLocalTerminalHostTransportFactory({
      resolveBinding: async () => binding1,
      proxyBinary: async () => "/staged/current-agent",
      assertSocket: async (path) => {
        if (path !== generation1.socketPath) throw new Error("insecure");
      },
      connect,
    });
    await factory.create(LOCAL_TERMINAL_HOST_TARGET_ID, binding1);
    expect(dialed[0]).toMatchObject({
      binaryPath: "/staged/current-agent",
      mode: "proxy",
      env: { BIGBUD_AGENT_STATE_DIR: generation1.statePath },
    });
    await expect(factory.create(LOCAL_TERMINAL_HOST_TARGET_ID, binding2)).rejects.toThrow(
      "insecure",
    );
  });

  it("F2: each owner reattaches through its own generation; new work goes to the newest", async () => {
    const { connect, dialed } = fakeConnect({
      [generation1.statePath]: hello1,
      [generation2.statePath]: hello2,
    });
    const pool = new RemoteAgentConnectionPool(
      makeLocalTerminalHostTransportFactory({
        resolveBinding: async () => binding2,
        proxyBinary: async () => "/staged/agent",
        assertSocket: async () => {},
        connect,
      }),
    );
    await pool.getBound(LOCAL_TERMINAL_HOST_TARGET_ID, binding1, ["terminal.pty"]);
    await pool.getBound(LOCAL_TERMINAL_HOST_TARGET_ID, binding2, ["terminal.pty"]);
    expect(dialed.map((input) => input.env?.BIGBUD_AGENT_STATE_DIR)).toEqual([
      generation1.statePath,
      generation2.statePath,
    ]);
    // An unpinned request resolves the admitted (newest) generation's binding.
    await pool.get(LOCAL_TERMINAL_HOST_TARGET_ID);
    expect(dialed.at(-1)?.env?.BIGBUD_AGENT_STATE_DIR).toBe(generation2.statePath);
    // A generation whose epoch changed (host restarted) is not silently reattached.
    await expect(
      pool.getBound(LOCAL_TERMINAL_HOST_TARGET_ID, { ...binding1, expectedEpoch: "stale" }),
    ).rejects.toThrow();
    pool.closeAll();
  });
});
