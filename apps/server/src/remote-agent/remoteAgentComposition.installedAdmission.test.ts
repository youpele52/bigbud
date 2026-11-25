import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { build } from "./remoteAgentAdmission.fixtures.ts";
import { detectInstalledProxyBinding } from "./remoteAgentComposition.installedAdmission.ts";
import { observeLocalInstalledSupervisor } from "./remoteAgentComposition.installedObservation.ts";
import { encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import type { RemoteAgentHello } from "./remoteAgentProtocol.ts";
import { emptyRemoteAgentRegistry } from "./remoteAgentInstall.registry.ts";

const target = "ssh:agent:approved";
const current = build(1, true);
const pending = build(2, true);
const launch = {
  id: current.runtime.generation,
  buildId: current.id,
  phase: "ready",
  epoch: "epoch",
} as const;
const state = {
  ...emptyRemoteAgentRegistry(),
  builds: [current, pending],
  current: current.id,
  pending: pending.id,
  currentConnectionId: "admitted",
  pins: [{ owner: "connection:admitted", buildId: current.id }],
  launches: [launch],
  admissions: [
    { id: "admitted", buildId: current.id, phase: "ready", epoch: launch.epoch } as const,
  ],
};
const observation = {
  executionTargetId: target,
  runtime: current.runtime,
  supervisorEpoch: launch.epoch,
  agentInstanceId: "instance",
};

describe("installed proxy binding detection", () => {
  it("pins the current admitted endpoint without promoting a pending build", () => {
    expect(detectInstalledProxyBinding(target, state, observation)).toEqual({
      kind: "ready",
      binding: {
        connectionId: "admitted",
        runtime: current.runtime,
        expectedEpoch: launch.epoch,
        expectedInstanceId: "instance",
      },
    });
  });

  it("does not infer an instance from a registry-only snapshot", () => {
    expect(detectInstalledProxyBinding(target, state)).toEqual({
      kind: "denied",
      reason: "observation-required",
    });
  });

  it.each([
    { executionTargetId: "ssh:agent:other" },
    { supervisorEpoch: "replacement" },
    { runtime: pending.runtime },
    { runtime: { ...current.runtime, binaryPath: "/elsewhere" } },
    { runtime: { ...current.runtime, socketPath: "/elsewhere/supervisor.sock" } },
  ])("rejects observation drift: %j", (patch) => {
    expect(detectInstalledProxyBinding(target, state, { ...observation, ...patch })).toEqual({
      kind: "denied",
      reason: "identity-mismatch",
    });
  });

  it.each([
    null,
    { ...state, currentConnectionId: null },
    { ...state, pins: [] },
    { ...state, builds: [{ ...current, authenticated: false }] },
  ])("rejects missing or untrusted admission", (snapshot) => {
    expect(detectInstalledProxyBinding(target, snapshot, observation)).toEqual({
      kind: "denied",
      reason: "not-admitted",
    });
  });

  it.each([
    { launches: [] },
    { launches: [{ ...launch, epoch: "replacement" }] },
    { launches: [launch, { ...launch, phase: "spawn-uncertain" as const }] },
    { removal: { id: "remove", controllerId: "controller", startedAt: 1 } },
    {
      restartReservations: [
        {
          id: "restart",
          buildId: current.id,
          generation: launch.id,
          expectedEpoch: launch.epoch,
          phase: "starting" as const,
        },
      ],
    },
    {
      retirementReservations: [
        { id: "retire", buildId: current.id, generation: launch.id, phase: "fenced" as const },
      ],
    },
  ])("rejects unsettled lifecycle evidence", (patch) => {
    expect(detectInstalledProxyBinding(target, { ...state, ...patch }, observation)).toEqual({
      kind: "denied",
      reason: "lifecycle-unsettled",
    });
  });
});

describe.skipIf(process.platform === "win32")("local installed supervisor observation", () => {
  async function withSupervisor(
    patch: Partial<RemoteAgentHello> | null,
    run: (runtime: typeof current.runtime) => Promise<void>,
  ) {
    const root = await mkdtemp("/tmp/bb-obs-");
    const runtime = {
      ...current.runtime,
      binaryPath: current.runtime.binaryPath.replace("/tmp/agent", root),
      statePath: `${root}/runtimes/${current.runtime.generation}`,
      socketPath: `${root}/runtimes/${current.runtime.generation}/supervisor.sock`,
      logPath: `${root}/runtimes/${current.runtime.generation}/supervisor.log`,
    };
    const server = createServer((socket) => {
      socket.once("data", () => {
        if (patch === null) {
          socket.end();
          return;
        }
        socket.end(
          encodeDelimitedFrame({
            type: "agentHello",
            value: {
              protocolMajor: 1,
              protocolMinor: 9,
              os: "linux",
              architecture: "aarch64",
              agentVersion: runtime.version,
              buildDigest: runtime.buildDigest,
              agentEpoch: launch.epoch,
              agentInstanceId: "from-live-socket",
              capabilities: [],
              maxFrameBytes: 1024,
              maxJournalBytes: 1024,
              maxOperationOutputBytes: 1024,
              ...patch,
            },
          }),
        );
      });
    });
    try {
      await mkdir(runtime.statePath, { recursive: true });
      server.listen(runtime.socketPath);
      await once(server, "listening");
      await run(runtime);
    } finally {
      try {
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }

  it("supplies the detector with the instance from the pinned socket", async () => {
    await withSupervisor({}, async (runtime) => {
      const observed = await observeLocalInstalledSupervisor({
        executionTargetId: target,
        runtime,
        expectedEpoch: launch.epoch,
      });
      const snapshot = { ...state, builds: [{ ...current, runtime }] };
      expect(detectInstalledProxyBinding(target, snapshot, observed)).toMatchObject({
        kind: "ready",
        binding: { runtime, expectedEpoch: launch.epoch, expectedInstanceId: "from-live-socket" },
      });
    });
  });

  it.each([
    { patch: { agentEpoch: "replacement" }, error: /epoch/ },
    { patch: { buildDigest: "different" }, error: /identity/ },
    { patch: { agentInstanceId: "" }, error: /identity/ },
    { patch: null, error: /EOF/ },
  ])("refuses unverifiable socket evidence: $patch", async ({ patch, error }) => {
    await withSupervisor(patch, async (runtime) => {
      await expect(
        observeLocalInstalledSupervisor({
          executionTargetId: target,
          runtime,
          expectedEpoch: launch.epoch,
        }),
      ).rejects.toThrow(error);
    });
  });
});
