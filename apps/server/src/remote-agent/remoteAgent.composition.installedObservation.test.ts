import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import type { RemoteAgentHello } from "./remoteAgentProtocol.ts";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { composeInstalledRemoteAgentStartup } from "./remoteAgentComposition.installedStartup.ts";
import {
  closeConfiguredRemoteAgentCompositions,
  getConfiguredRemoteAgentComposition,
  installedRemoteAgentStartup,
  liveConfiguredRemoteAgentConnection,
} from "./remoteAgentDefault.ts";

const target = "ssh:agent:startup";
const other = "ssh:agent:other";
const epoch = "epoch-1";
const instance = "instance-from-socket";

function runtimeAt(root: string): RemoteAgentRuntime {
  const generation = "g1";
  const version = "0.2.207";
  const sha256 = "1".repeat(64);
  const statePath = `${root}/runtimes/${generation}`;
  return {
    generation,
    version,
    sha256,
    buildDigest: "digest1",
    targetTriple: "aarch64-unknown-linux-gnu",
    binaryPath: `${root}/bin/${version}/${sha256}/bigbud-remote-agent`,
    statePath,
    socketPath: `${statePath}/supervisor.sock`,
    logPath: `${statePath}/supervisor.log`,
    origin: "managed",
  };
}

function healthyRegistry(runtime: RemoteAgentRuntime): RemoteAgentRegistry {
  const id = `${runtime.version}:${runtime.sha256}:${runtime.targetTriple}`;
  return {
    ...emptyRemoteAgentRegistry(),
    builds: [
      { id, runtime, health: "healthy", promotion: 1, binary: "present", authenticated: true },
    ],
    current: id,
    currentConnectionId: "admitted",
    pins: [{ owner: "connection:admitted", buildId: id }],
    launches: [{ id: runtime.generation, buildId: id, phase: "ready", epoch }],
    admissions: [{ id: "admitted", buildId: id, phase: "ready", epoch }],
  };
}

function hello(runtime: RemoteAgentRuntime, patch: Partial<RemoteAgentHello> = {}) {
  return {
    protocolMajor: 1,
    protocolMinor: 9,
    os: "linux",
    architecture: "aarch64",
    agentVersion: runtime.version,
    buildDigest: runtime.buildDigest,
    agentEpoch: epoch,
    agentInstanceId: instance,
    capabilities: [],
    maxFrameBytes: 64 * 1024,
    maxJournalBytes: 1024,
    maxOperationOutputBytes: 1024,
    ...patch,
  } satisfies RemoteAgentHello;
}

function owner() {
  return { openAgentProxy: vi.fn(async () => Promise.reject(new Error("never dials"))) };
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  closeConfiguredRemoteAgentCompositions();
  for (const server of servers.splice(0)) await server.close();
});

async function withSupervisor(
  patch: {
    readonly hello?: Partial<RemoteAgentHello> | null;
    readonly registry?: (runtime: RemoteAgentRuntime) => RemoteAgentRegistry | null;
  } = {},
  run: (input: {
    runtime: RemoteAgentRuntime;
    registry: RemoteAgentRegistry | null;
  }) => Promise<void>,
) {
  const root = await mkdtemp("/tmp/bb-startup-");
  const runtime = runtimeAt(root);
  await mkdir(runtime.statePath, { recursive: true });
  const server = createServer((socket) => {
    socket.once("data", () => {
      if (patch.hello === null) return socket.end();
      socket.end(
        encodeDelimitedFrame({ type: "agentHello", value: hello(runtime, patch.hello ?? {}) }),
      );
    });
  });
  server.listen(runtime.socketPath);
  await once(server, "listening");
  servers.push({
    close: () =>
      new Promise<void>((resolve) =>
        server.listening ? server.close(() => resolve()) : resolve(),
      ),
  });
  try {
    await run({ runtime, registry: (patch.registry ?? healthyRegistry)(runtime) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("normal-startup installed agent composition", () => {
  it("composes a verified endpoint and binds only its owner at startup", async () => {
    await withSupervisor({}, async ({ runtime, registry }) => {
      const proxyOwner = owner();
      const result = await composeInstalledRemoteAgentStartup({
        executionTargetId: target,
        runtime,
        expectedEpoch: epoch,
        owner: proxyOwner,
        registry,
      });
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") return;
      expect(result.observation).toMatchObject({
        executionTargetId: target,
        supervisorEpoch: epoch,
        agentInstanceId: instance,
      });
      expect(result.composition.managed).toBe(true);
      // The configured server resolves the exact endpoint through that owner.
      expect(installedRemoteAgentStartup(target)).toBe(result.composition);
      expect(getConfiguredRemoteAgentComposition(target)).toBe(result.composition);
      const resolve = result.composition.ptyResolver.resolveProfileBinding;
      expect(resolve).toBeDefined();
      await expect(resolve!(target)).resolves.toMatchObject({
        expectedEpoch: epoch,
        expectedInstanceId: instance,
      });
      // Any other endpoint is refused; there is no ambient or legacy fallback.
      await expect(resolve!(other)).rejects.toThrow();
      // Composition alone never dials SSH, and no live connection was fabricated.
      expect(proxyOwner.openAgentProxy).not.toHaveBeenCalled();
      expect(liveConfiguredRemoteAgentConnection(target)).toBeNull();
      expect(getConfiguredRemoteAgentComposition(other)).not.toBe(result.composition);
    });
  });

  it.each([
    {
      label: "epoch drift",
      patch: { hello: { agentEpoch: "replacement" } },
      reason: "identity-mismatch",
    },
    {
      label: "identity drift",
      patch: { hello: { buildDigest: "different" } },
      reason: "identity-mismatch",
    },
    { label: "a closed socket", patch: { hello: null }, reason: "observation-required" },
    {
      label: "an unsettled lifecycle",
      patch: {
        registry: (runtime: RemoteAgentRuntime) => ({
          ...healthyRegistry(runtime),
          restartReservations: [
            {
              id: "restart",
              buildId: `0.2.207:${runtime.sha256}:${runtime.targetTriple}`,
              generation: runtime.generation,
              expectedEpoch: epoch,
              phase: "starting" as const,
            },
          ],
        }),
      },
      reason: "lifecycle-unsettled",
    },
    {
      label: "an absent registry",
      patch: { registry: () => null },
      reason: "not-admitted",
    },
  ])("refuses $label without composing or dialing", async ({ patch, reason }) => {
    await withSupervisor(patch, async ({ runtime, registry }) => {
      const proxyOwner = owner();
      const result = await composeInstalledRemoteAgentStartup({
        executionTargetId: target,
        runtime,
        expectedEpoch: epoch,
        owner: proxyOwner,
        registry,
      });
      expect(result).toEqual({ kind: "refused", reason });
      expect(getConfiguredRemoteAgentComposition(target)).toBeNull();
      expect(installedRemoteAgentStartup(target)).toBeNull();
      expect(proxyOwner.openAgentProxy).not.toHaveBeenCalled();
      expect(liveConfiguredRemoteAgentConnection(target)).toBeNull();
      // The process-default composition cannot re-enter a refused endpoint.
      const fallback = getConfiguredRemoteAgentComposition();
      expect(fallback).not.toBeNull();
      await expect(fallback!.pool.get(target)).rejects.toThrow(/refused/);
      expect(proxyOwner.openAgentProxy).not.toHaveBeenCalled();
    });
  });

  it("refuses when the pinned socket is missing", async () => {
    const proxyOwner = owner();
    const runtime = runtimeAt("/tmp/bb-startup-missing");
    const result = await composeInstalledRemoteAgentStartup({
      executionTargetId: target,
      runtime,
      expectedEpoch: epoch,
      owner: proxyOwner,
      registry: healthyRegistry(runtime),
    });
    expect(result).toEqual({ kind: "refused", reason: "observation-required" });
    expect(getConfiguredRemoteAgentComposition(target)).toBeNull();
    expect(proxyOwner.openAgentProxy).not.toHaveBeenCalled();
  });
});
