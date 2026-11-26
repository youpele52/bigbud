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
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import {
  startSelectedV2OwnerProcess,
  type V2OwnerSessionSource,
} from "./ServerManager.ownerV2.selected.ts";
import { FixtureEvents } from "./Test.fixtures.ts";
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

function ownerClient(
  port: number,
  password: string,
  calls: string[],
  closePhase: "closed" | "lost" | "rejected" = "closed",
) {
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
      const state: ProofOpencodeState = { lease: ticket, phase: closePhase };
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

  it.each([
    ["closed", true],
    ["lost", false],
    ["rejected", false],
  ] as const)(
    "frees the native slot only on confirmed owner teardown (%s)",
    async (closePhase, confirmed) => {
      const requests: string[] = [];
      const password = "d".repeat(64);
      const port = await v2Server(password, requests);
      const calls: string[] = [];
      const owner = makeV2SshOwner(
        ownerClient(port, password, calls, closePhase),
        config.runtimeTargetId,
        binding,
        config.binaryPath,
      );
      const process = track(await startOwnedV2Process(config, undefined, owner));
      expect(process.hasExited?.()).toBe(false);
      await process.close();
      expect(calls).toContain("close");
      expect(process.hasExited?.()).toBe(confirmed);
    },
  );

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

describe("selected OpenCode v2 owner composition through the server manager", () => {
  const bounds = {
    maxProcesses: 2,
    maxOwners: 2,
    maxQueuedEvents: 4,
    maxEventBytes: 1024,
    consumerTimeoutMs: 100,
  };

  function compositionSource(fixture?: { port: number; password: string; calls: string[] }) {
    return {
      async target(targetId: string) {
        if (!fixture || targetId !== config.runtimeTargetId) return undefined;
        return {
          targetId,
          owner: makeV2SshOwner(
            ownerClient(fixture.port, fixture.password, fixture.calls),
            targetId,
            binding,
            config.binaryPath,
          ),
          serviceBinding: config.binaryPath,
        };
      },
    } satisfies V2OwnerSessionSource;
  }

  it("reaches the owner endpoint instead of a borrowed shared service", async () => {
    const requests: string[] = [];
    const password = "c".repeat(64);
    const port = await v2Server(password, requests);
    const calls: string[] = [];
    const owners: OwnedV2Process[] = [];
    const events = new FixtureEvents();
    const manager = new OpencodeV2ServerManager({
      ...bounds,
      start: async (next) => {
        const owned = await startSelectedV2OwnerProcess(
          next,
          compositionSource({ port, password, calls }),
          {
            platform: "linux",
          },
        );
        owners.push(owned);
        return {
          ...owned,
          client: {
            ...owned.client,
            event: {
              subscribe: (options) =>
                events.subscribe(options?.signal ?? new AbortController().signal),
            },
          },
        };
      },
    });
    try {
      const lease = await manager.acquire(config);
      expect(calls[0]).toBe("open v2 /srv/work");
      expect(requests[0]).toBe(
        `/api/info Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      );
      expect(spawnSpy).not.toHaveBeenCalled();
      await lease.release();
      expect(calls).toContain("close");
    } finally {
      await manager.close();
    }
  });

  it("keeps a remote target typed-refused instead of borrowing the shared service", async () => {
    const calls: string[] = [];
    // A live owner fixture whose source carries no v2 binding: the refusal must
    // happen before the owner is ever opened, which `calls` now observes.
    const source: V2OwnerSessionSource = {
      async target(targetId) {
        const ready = await compositionSource({ port: 1, password: "e".repeat(64), calls }).target(
          targetId,
        );
        return ready && { ...ready, serviceBinding: undefined };
      },
    };
    const manager = new OpencodeV2ServerManager({
      ...bounds,
      start: (next) => startSelectedV2OwnerProcess(next, source, { platform: "linux" }),
    });
    try {
      await expect(manager.acquire(config)).rejects.toThrow("acquisition-unverified");
      expect(calls).toEqual([]);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      await manager.close();
    }
  });
});
