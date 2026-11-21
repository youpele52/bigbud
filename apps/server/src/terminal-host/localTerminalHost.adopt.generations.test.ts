import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { adoptLocalTerminalHosts } from "./localTerminalHost.adopt.ts";
import {
  localTerminalHostGenerationPaths,
  localTerminalHostPaths,
} from "./localTerminalHost.paths.ts";
import {
  adoptionDeps,
  fakeHostHello,
  fakeProcesses,
  makeShortTerminalHostRoot,
} from "./localTerminalHost.testUtils.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function rootWithDirs(dirs: number[]) {
  const root = await makeShortTerminalHostRoot();
  cleanups.push(root.cleanup);
  await mkdir(root.paths.root, { mode: 0o700 });
  for (const generation of dirs)
    await mkdir(localTerminalHostGenerationPaths(root.paths.root, generation).statePath, {
      mode: 0o700,
    });
  return root;
}

describe("local terminal host generations", () => {
  it("F2: two generations with PTYs keep their own bindings; the newest is admitted", async () => {
    const { paths } = await rootWithDirs([1, 2]);
    const processes = fakeProcesses();
    const deps = adoptionDeps(paths, {
      probes: {
        1: { kind: "hello", hello: fakeHostHello({ agentEpoch: "e1", buildDigest: "digest-a" }) },
        2: { kind: "hello", hello: fakeHostHello({ agentEpoch: "e2", buildDigest: "digest-b" }) },
      },
      processes,
      owners: { "state-1": true, "state-2": true },
    });
    const result = await adoptLocalTerminalHosts(deps);
    expect(result.admitted?.binding).toMatchObject({
      connectionId: "state-2",
      expectedEpoch: "e2",
    });
    expect(result.attached.map((entry) => entry.binding.connectionId)).toEqual([
      "state-1",
      "state-2",
    ]);
    expect(result.attached[0]?.binding.runtime.statePath).toBe(
      localTerminalHostGenerationPaths(paths.root, 1).statePath,
    );
    expect(processes.signals).toEqual([]);
    expect((await deps.registry.read()).map((record) => record.state)).toEqual([
      "draining",
      "running",
    ]);
  });

  it("never admits an older host lacking a required capability, but keeps it attached", async () => {
    const { paths } = await rootWithDirs([3]);
    const deps = adoptionDeps(paths, {
      probes: {
        3: {
          kind: "hello",
          hello: fakeHostHello({ capabilityNames: ["terminal.pty", "workspace.files"] }),
        },
      },
      owners: { "state-3": true },
    });
    const result = await adoptLocalTerminalHosts(deps);
    expect(result.admitted).toBeUndefined();
    expect(result.attached.map((entry) => [entry.generation.name, entry.capable])).toEqual([
      ["state-3", false],
    ]);
    expect(result.highestGeneration).toBe(3);
    expect(await deps.registry.read()).toMatchObject([{ generation: 3, state: "draining" }]);
  });

  it("stops a proven-empty older compatible generation once a newer one is admitted", async () => {
    const { paths } = await rootWithDirs([1, 2]);
    const processes = fakeProcesses({ 41: { status: "verified", children: false } });
    const deps = adoptionDeps(paths, {
      probes: {
        1: {
          kind: "hello",
          hello: fakeHostHello({ agentEpoch: "e1", processId: 41, processStartTimeMs: 5 }),
        },
        2: { kind: "hello", hello: fakeHostHello({ agentEpoch: "e2" }) },
      },
      processes,
    });
    const result = await adoptLocalTerminalHosts(deps);
    expect(processes.signals).toEqual([{ pid: 41, signal: "SIGTERM" }]);
    expect(result.attached.map((entry) => entry.generation.name)).toEqual(["state-2"]);
  });

  it("skips generations whose socket path would exceed 100 bytes", async () => {
    const root = await makeShortTerminalHostRoot();
    cleanups.push(root.cleanup);
    const longState = `${root.stateDir}/${"d".repeat(80)}`;
    const paths = localTerminalHostPaths(longState);
    await mkdir(localTerminalHostGenerationPaths(paths.root, 1).statePath, {
      recursive: true,
      mode: 0o700,
    });
    let probed = false;
    const deps = adoptionDeps(paths, { probes: {} });
    const result = await adoptLocalTerminalHosts({
      ...deps,
      probe: async () => {
        probed = true;
        return { kind: "gone" };
      },
    });
    expect(probed).toBe(false);
    expect(result.socketPathTooLong).toBe(true);
  });

  it("stable and dev state roots adopt independent hosts concurrently", async () => {
    const stable = await rootWithDirs([1]);
    const dev = await rootWithDirs([1]);
    const [stableResult, devResult] = await Promise.all([
      adoptLocalTerminalHosts(
        adoptionDeps(stable.paths, {
          probes: { 1: { kind: "hello", hello: fakeHostHello({ agentEpoch: "stable" }) } },
        }),
      ),
      adoptLocalTerminalHosts(
        adoptionDeps(dev.paths, {
          probes: { 1: { kind: "hello", hello: fakeHostHello({ agentEpoch: "dev" }) } },
        }),
      ),
    ]);
    expect(stableResult.admitted?.binding.runtime.socketPath).not.toBe(
      devResult.admitted?.binding.runtime.socketPath,
    );
    expect([
      stableResult.admitted?.binding.expectedEpoch,
      devResult.admitted?.binding.expectedEpoch,
    ]).toEqual(["stable", "dev"]);
  });
});
