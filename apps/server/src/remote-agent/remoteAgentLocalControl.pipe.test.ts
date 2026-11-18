import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RemoteAgentBackendUnavailableError,
  sendRemoteAgentControlRequest,
} from "./remoteAgentLocalControl.client.ts";
import {
  readRemoteAgentControlEndpoint,
  remoteAgentControlEndpointPath,
} from "./remoteAgentLocalControl.endpoint.ts";
import { remoteAgentControlSocketPath } from "./remoteAgentLocalControl.protocol.ts";
import { startRemoteAgentLocalControlServer } from "./remoteAgentLocalControl.server.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

/** Named-pipe transport exercised on POSIX: the "pipe" address is a short Unix socket path. */
async function startPipeFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "bbp-"));
  directories.push(stateDir);
  const socketPath = remoteAgentControlSocketPath(stateDir);
  const controlDir = dirname(socketPath);
  const handle = vi.fn(async () => ({ v: 1 as const, ok: true as const, result: "handled" }));
  const server = await startRemoteAgentLocalControlServer({
    socketPath,
    handle,
    transport: "named-pipe",
    pipeAddress: (id) => join(controlDir, `p${id.slice(0, 8)}.sock`),
  });
  const client = { transport: "named-pipe" as const, addressAllowed: () => true };
  return { socketPath, controlDir, handle, server, client };
}

function rawRequest(address: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(address);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(line));
    socket.on("data", (chunk: string) => (buffered += chunk));
    socket.on("end", () => resolve(buffered));
    socket.on("error", reject);
  });
}

describe("remote agent control over the named-pipe transport", () => {
  it("publishes a private endpoint and serves only requests carrying its token", async () => {
    const fixture = await startPipeFixture();
    try {
      const endpointPath = remoteAgentControlEndpointPath(fixture.controlDir);
      expect(statSync(endpointPath).mode & 0o777).toBe(0o600);
      const endpoint = await readRemoteAgentControlEndpoint(fixture.controlDir, () => true);
      expect(endpoint?.token).toMatch(/^[0-9a-f]{64}$/);

      const ok = await sendRemoteAgentControlRequest(
        fixture.socketPath,
        { method: "status", target: "vps" },
        2_000,
        fixture.client,
      );
      expect(ok).toEqual({ v: 1, ok: true, result: "handled" });

      for (const auth of [undefined, "0".repeat(64), 7]) {
        const reply = await rawRequest(
          endpoint!.address,
          `${JSON.stringify({ v: 1, ...(auth === undefined ? {} : { auth }), method: "status", target: "vps" })}\n`,
        );
        expect(JSON.parse(reply)).toMatchObject({
          ok: false,
          error: { code: "invalid-request", message: "Request is not authorized." },
        });
      }
      expect(fixture.handle).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.server.close();
    }
    expect(() => statSync(remoteAgentControlEndpointPath(fixture.controlDir))).toThrow();
  });

  it("reports an unavailable backend when no endpoint is published or it is malformed", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bbp-"));
    directories.push(stateDir);
    const socketPath = remoteAgentControlSocketPath(stateDir);
    const request = () =>
      sendRemoteAgentControlRequest(socketPath, { method: "status", target: "vps" }, 1_000, {
        transport: "named-pipe",
      });
    await expect(request()).rejects.toBeInstanceOf(RemoteAgentBackendUnavailableError);
    const fixture = await startPipeFixture();
    await fixture.server.close();
    // The production address check accepts only bigbud pipe names, never arbitrary paths.
    mkdirSync(dirname(socketPath), { recursive: true });
    writeFileSync(
      remoteAgentControlEndpointPath(dirname(socketPath)),
      JSON.stringify({ address: "/tmp/elsewhere.sock", token: "a".repeat(64) }),
    );
    await expect(request()).rejects.toBeInstanceOf(RemoteAgentBackendUnavailableError);
  });

  it("does not remove a newer backend's endpoint when an older server closes", async () => {
    const fixture = await startPipeFixture();
    const newer = {
      address: "\\\\.\\pipe\\bigbud-remote-agent-" + "b".repeat(32),
      token: "c".repeat(64),
    };
    writeFileSync(remoteAgentControlEndpointPath(fixture.controlDir), JSON.stringify(newer));
    await fixture.server.close();
    expect(await readRemoteAgentControlEndpoint(fixture.controlDir)).toEqual(newer);
  });
});
