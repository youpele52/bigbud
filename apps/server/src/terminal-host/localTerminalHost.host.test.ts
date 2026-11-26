import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { StagedLocalTerminalHostBinary } from "./localTerminalHost.binary.ts";
import {
  makeLocalTerminalHostController,
  type LocalTerminalHostControllerDeps,
} from "./localTerminalHost.host.ts";
import {
  LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES,
  localTerminalHostGenerationPaths,
  localTerminalHostPaths,
  type LocalTerminalHostGenerationPaths,
  type LocalTerminalHostMode,
  type LocalTerminalHostPaths,
} from "./localTerminalHost.paths.ts";
import type { LocalTerminalHostProbe } from "./localTerminalHost.probe.ts";
import type { LocalTerminalHostRecord } from "./localTerminalHost.registry.ts";
import {
  adoptionDeps,
  fakeHostHello,
  fakeProcesses,
  makeShortTerminalHostRoot,
  type FakeProcesses,
} from "./localTerminalHost.testUtils.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const staged: StagedLocalTerminalHostBinary = {
  path: "/staged/digest-b/bigbud-remote-agent",
  sha256: "a".repeat(64),
  check: {
    version: "0.4.1",
    protocolMajor: 1,
    protocolMinor: 8,
    buildDigest: "digest-b",
    os: "x",
    architecture: "y",
  },
};

/** A real listening socket so the controller's liveness check sees a live admitted host. */
async function listen(generation: LocalTerminalHostGenerationPaths) {
  await mkdir(generation.statePath, { recursive: true, mode: 0o700 });
  const server: Server = createServer().listen(generation.socketPath);
  await new Promise((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

function controllerFor(
  paths: LocalTerminalHostPaths,
  input: {
    readonly mode?: LocalTerminalHostMode;
    readonly probes?: Record<number, LocalTerminalHostProbe>;
    readonly freshHello?: ReturnType<typeof fakeHostHello>;
    readonly processes?: FakeProcesses;
    readonly owners?: Record<string, boolean | undefined>;
    readonly launchFails?: boolean;
    readonly requiredCapabilities?: ReadonlyArray<string>;
  },
) {
  const base = adoptionDeps(paths, {
    probes: input.probes ?? {},
    ...(input.requiredCapabilities ? { requiredCapabilities: input.requiredCapabilities } : {}),
    ...(input.processes ? { processes: input.processes } : {}),
    ...(input.owners ? { owners: input.owners } : {}),
  });
  const launches: Array<{
    generation: number;
    recordsAtLaunch: ReadonlyArray<LocalTerminalHostRecord>;
  }> = [];
  const fresh = new Map<number, LocalTerminalHostProbe>();
  const deps: LocalTerminalHostControllerDeps = {
    ...base,
    mode: input.mode ?? "enabled",
    stage: async () => staged,
    verifyStaged: async () => {},
    collectRuntimes: async () => [],
    prepareGeneration: async (generation) => {
      await mkdir(generation.statePath, { recursive: true, mode: 0o700 });
    },
    probe: async (generation) =>
      fresh.get(generation.generation) ?? input.probes?.[generation.generation] ?? { kind: "gone" },
    launch: async ({ generation }) => {
      launches.push({
        generation: generation.generation,
        recordsAtLaunch: await base.registry.read(),
      });
      if (input.launchFails) throw new Error("spawn failed");
      await listen(generation);
      fresh.set(generation.generation, {
        kind: "hello",
        hello: input.freshHello ?? fakeHostHello({ agentEpoch: `fresh-${generation.generation}` }),
      });
      return { pid: 9000 + generation.generation };
    },
  };
  return {
    controller: makeLocalTerminalHostController(deps),
    launches,
    registry: base.registry,
    logs: base.logs,
  };
}

async function root() {
  const value = await makeShortTerminalHostRoot();
  cleanups.push(value.cleanup);
  await mkdir(value.paths.root, { mode: 0o700 });
  return value;
}

describe("local terminal host controller", () => {
  it("launches state-1 lazily with a provisional record written before launch", async () => {
    const { paths } = await root();
    const processes = fakeProcesses({ 9001: { status: "verified" } });
    const { controller, launches, registry } = controllerFor(paths, { processes });
    await controller.ready();
    expect(launches).toEqual([]);
    const binding = await controller.resolveAdmittedBinding();
    expect(binding).toMatchObject({ connectionId: "state-1", expectedEpoch: "fresh-1" });
    expect(launches[0]?.recordsAtLaunch).toMatchObject([
      { generation: 1, state: "launching", binaryPath: staged.path },
    ]);
    expect(launches[0]?.recordsAtLaunch[0]?.pid).toBeUndefined();
    expect(await registry.read()).toMatchObject([
      { generation: 1, state: "running", pid: 9001, epoch: "fresh-1" },
    ]);
    // Already admitted and alive: no second launch.
    await controller.resolveAdmittedBinding();
    expect(launches).toHaveLength(1);
  });

  it("starts state-<n+1> beside an older host lacking capabilities, which keeps draining", async () => {
    const { paths } = await root();
    await mkdir(localTerminalHostGenerationPaths(paths.root, 3).statePath, { mode: 0o700 });
    const { controller, launches, registry } = controllerFor(paths, {
      probes: { 3: { kind: "hello", hello: fakeHostHello({ capabilityNames: ["terminal.pty"] }) } },
      owners: { "state-3": true },
      processes: fakeProcesses({ 9004: { status: "verified" } }),
    });
    const binding = await controller.resolveAdmittedBinding();
    expect(launches.map((launch) => launch.generation)).toEqual([4]);
    expect(binding?.connectionId).toBe("state-4");
    expect((await registry.read()).map((record) => [record.generation, record.state])).toEqual([
      [3, "draining"],
      [4, "running"],
    ]);
    expect((await controller.knownRuntimes()).map((runtime) => runtime.generation)).toEqual([
      "state-3",
      "state-4",
    ]);
  });

  it("an S1-era host without the 1.9 capabilities drains while state-<n+1> takes new terminals", async () => {
    const { paths } = await root();
    await mkdir(localTerminalHostGenerationPaths(paths.root, 1).statePath, { mode: 0o700 });
    const { controller, launches, registry } = controllerFor(paths, {
      requiredCapabilities: LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES,
      probes: { 1: { kind: "hello", hello: fakeHostHello() } },
      owners: { "state-1": true },
      freshHello: fakeHostHello({
        agentEpoch: "fresh-2",
        capabilityNames: LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES,
      }),
      processes: fakeProcesses({ 9002: { status: "verified" } }),
    });
    // Nothing is admitted and nothing launches until a new terminal needs a host.
    expect(await controller.currentAdmittedBinding()).toBeUndefined();
    expect(launches).toEqual([]);
    expect((await controller.resolveAdmittedBinding())?.connectionId).toBe("state-2");
    expect((await controller.currentAdmittedBinding())?.connectionId).toBe("state-2");
    expect((await registry.read()).map((record) => [record.generation, record.state])).toEqual([
      [1, "draining"],
      [2, "running"],
    ]);
  });

  it("kill switch: adopts but never launches or admits new host terminals", async () => {
    const { paths } = await root();
    const { controller, launches } = controllerFor(paths, { mode: "adopt-only" });
    expect(await controller.resolveAdmittedBinding()).toBeUndefined();
    expect(launches).toEqual([]);
  });

  it("falls back in-process when the socket path would be too long", async () => {
    const value = await makeShortTerminalHostRoot();
    cleanups.push(value.cleanup);
    const paths = localTerminalHostPaths(`${value.stateDir}/${"x".repeat(80)}`);
    const { controller, launches, logs } = controllerFor(paths, {});
    expect(await controller.resolveAdmittedBinding()).toBeUndefined();
    expect(launches).toEqual([]);
    expect(logs.some((line) => line.includes("too long"))).toBe(true);
  });

  it("stops its own fresh host when it lacks capabilities, forgets it, and cools down", async () => {
    const { paths } = await root();
    const processes = fakeProcesses({ 9001: { status: "verified" } });
    const { controller, launches, registry } = controllerFor(paths, {
      processes,
      freshHello: fakeHostHello({ capabilityNames: [] }),
    });
    expect(await controller.resolveAdmittedBinding()).toBeUndefined();
    expect(processes.signals).toEqual([{ pid: 9001, signal: "SIGTERM" }]);
    expect(await registry.read()).toEqual([]);
    expect(await controller.resolveAdmittedBinding()).toBeUndefined();
    expect(launches).toHaveLength(1);
  });

  it("relaunches on the next open after the admitted host crashed", async () => {
    const { paths } = await root();
    const processes = fakeProcesses();
    const { controller, launches } = controllerFor(paths, { processes });
    await controller.resolveAdmittedBinding();
    // Host 9001 is not in the fake process table, so it reads as dead.
    const next = await controller.resolveAdmittedBinding();
    expect(launches.map((launch) => launch.generation)).toEqual([1, 2]);
    expect(next?.connectionId).toBe("state-2");
  });

  it("Close them refuses a draining host whose PID cannot be verified", async () => {
    const { paths } = await root();
    await mkdir(localTerminalHostGenerationPaths(paths.root, 1).statePath, { mode: 0o700 });
    const processes = fakeProcesses({ 500: { status: "mismatch", children: true } });
    const { controller, registry } = controllerFor(paths, {
      mode: "adopt-only",
      probes: { 1: { kind: "incompatible", reason: "major 2" } },
      processes,
    });
    await registry.update(() => [
      {
        generation: 1,
        state: "running",
        binaryPath: "",
        capabilities: [],
        pid: 500,
        pidStartTime: 1,
        launchedAt: 1,
      },
    ]);
    await controller.ready();
    expect(controller.notices()).toMatchObject([{ generation: 1, canClose: false }]);
    await expect(controller.closeDrainingHost(1)).rejects.toThrow("could not be verified");
    expect(processes.signals).toEqual([]);
  });
});
