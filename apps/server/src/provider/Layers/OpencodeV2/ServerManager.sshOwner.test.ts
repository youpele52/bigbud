import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProofOpencodeServiceScope,
  ProofOpencodeState,
} from "../../../ssh/sshOwnerPickerProof.codec.opencode.ts";
import type { PickerProofProductionProxyClient } from "../../../ssh/sshOwnerPickerProof.client.productionProxy.ts";
import { V2SshOwnerUnavailable, makeV2SshOwner } from "./ServerManager.sshOwner.ts";
import { startOwnedV2Process } from "./ServerManager.child.ts";
import type { OwnedV2Process, V2IsolatedProcessConfig } from "./ServerManager.types.ts";

const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnSpy,
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  spawnSpy.mockClear();
});

const binding = () => ({
  ownerEpoch: new Uint8Array(32).fill(1),
  targetGeneration: new Uint8Array(32).fill(2),
});

const config: V2IsolatedProcessConfig = {
  runtimeTargetId: "ssh:fixture",
  binaryPath: "/opt/opencode/opencode",
  // A local profile path would only be used by the local launcher; the owner
  // path must not create or inspect it.
  profileRoot: "/nonexistent/bigbud-v2-profile/not-a-directory",
  workspaceRoot: "/srv/work",
};

/** Loopback v2 fixture: authenticated `/api/info` only, no models or tools. */
async function v2Server(password: string, requests: string[]) {
  const server = http.createServer((request, response) => {
    requests.push(`${request.url} ${request.headers.authorization ?? ""}`);
    if (request.url === "/api/info") {
      if (
        request.headers.authorization !==
        `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
      ) {
        response.writeHead(401);
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ version: "2.1.4", pid: 4242, urls: [], paths: { tmp: "/tmp" } }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

function ownerClient(port: number, password: string, calls: string[]) {
  let lease: Uint8Array | undefined;
  const client: Pick<
    PickerProofProductionProxyClient,
    "openOpencodeV2" | "opencodeV2Status" | "closeOpencodeV2"
  > = {
    async openOpencodeV2(ticket, scope) {
      calls.push(`open ${scope.transport} ${scope.cwd}`);
      lease = Uint8Array.from(ticket);
      return { lease, phase: "ready", localPort: port, password };
    },
    async opencodeV2Status(ticket) {
      calls.push("status");
      if (!lease || !Buffer.from(ticket).equals(Buffer.from(lease)))
        throw new Error("lease mismatch");
      return { lease, phase: "ready", localPort: port, password };
    },
    async closeOpencodeV2(ticket) {
      calls.push("close");
      const state: ProofOpencodeState = { lease: ticket, phase: "closed" };
      lease = undefined;
      return state;
    },
  };
  return client;
}

function track(process: OwnedV2Process) {
  cleanups.push(() => process.close().catch(() => undefined));
  return process;
}

describe("OpenCode v2 SSH owner acquisition", () => {
  it("starts through the owner, hands the SDK its endpoint and credential, and never spawns", async () => {
    const requests: string[] = [];
    const password = "a".repeat(64);
    const port = await v2Server(password, requests);
    const calls: string[] = [];
    const client = ownerClient(port, password, calls);
    const owner = makeV2SshOwner(client, config.runtimeTargetId, binding, config.binaryPath);
    const process = track(await startOwnedV2Process(config, undefined, owner));
    expect((await process.client.server.info()).version).toBe("2.1.4");
    expect(process.isRunning()).toBe(true);
    expect(requests[0]).toBe(
      `/api/info Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    );
    expect(calls[0]).toBe("open v2 /srv/work");
    expect(spawnSpy).not.toHaveBeenCalled();
    await process.close();
    expect(calls).toContain("close");
    expect(process.isRunning()).toBe(false);
  });

  it("keeps the typed refusal when no owner can provide v2", async () => {
    await expect(startOwnedV2Process(config)).rejects.toBeInstanceOf(V2SshOwnerUnavailable);
    const { workspaceRoot: _localRoot, ...withoutWorkspace } = config;
    await expect(startOwnedV2Process(withoutWorkspace)).rejects.toBeInstanceOf(
      V2SshOwnerUnavailable,
    );
  });

  it("refuses a ready state without the owner credential", async () => {
    const requests: string[] = [];
    const port = await v2Server("b".repeat(64), requests);
    const calls: string[] = [];
    const client = ownerClient(port, "b".repeat(64), calls);
    const uncredentialed = {
      ...client,
      async openOpencodeV2(ticket: Uint8Array, scope: ProofOpencodeServiceScope) {
        const state = await client.openOpencodeV2(ticket, scope);
        return { lease: state.lease, phase: "ready" as const, localPort: port };
      },
    };
    const owner = makeV2SshOwner(
      uncredentialed,
      config.runtimeTargetId,
      binding,
      config.binaryPath,
    );
    await expect(startOwnedV2Process(config, undefined, owner)).rejects.toMatchObject({
      code: "protocolError",
    });
    expect(calls).toContain("close");
  });
});
