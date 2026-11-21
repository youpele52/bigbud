import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { adoptLocalTerminalHosts } from "./localTerminalHost.adopt.ts";
import { localTerminalHostGenerationPaths } from "./localTerminalHost.paths.ts";
import {
  makeLocalTerminalHostRegistry,
  upsertLocalTerminalHostRecord,
  type LocalTerminalHostRecord,
} from "./localTerminalHost.registry.ts";
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

async function rootWith(records: ReadonlyArray<LocalTerminalHostRecord>, dirs: number[] = []) {
  const root = await makeShortTerminalHostRoot();
  cleanups.push(root.cleanup);
  await mkdir(root.paths.root, { mode: 0o700 });
  for (const generation of dirs)
    await mkdir(localTerminalHostGenerationPaths(root.paths.root, generation).statePath, {
      mode: 0o700,
    });
  const registry = makeLocalTerminalHostRegistry(root.paths);
  for (const record of records)
    await registry.update((current) => upsertLocalTerminalHostRecord(current, record));
  return root;
}

const record = (overrides: Partial<LocalTerminalHostRecord>): LocalTerminalHostRecord => ({
  generation: 1,
  state: "running",
  binaryPath: "/staged/old/bigbud-remote-agent",
  agentVersion: "0.4.0",
  buildDigest: "digest-a",
  capabilities: ["terminal.pty"],
  epoch: "epoch-1",
  pid: 500,
  pidStartTime: 1_000,
  launchedAt: 1,
  ...overrides,
});

describe("local terminal host adoption", () => {
  it("adopts across a digest change with live terminals: same PID, nothing restarted", async () => {
    // The staged binary is now digest-b (dev rebuild or app update); the running host is digest-a.
    const { paths } = await rootWith([record({})], [1]);
    const processes = fakeProcesses({ 500: { status: "verified", children: true } });
    const deps = adoptionDeps(paths, {
      probes: { 1: { kind: "hello", hello: fakeHostHello({ buildDigest: "digest-a" }) } },
      processes,
      owners: { "state-1": true },
    });
    const result = await adoptLocalTerminalHosts(deps);
    expect(result.admitted?.binding.runtime.buildDigest).toBe("digest-a");
    expect(result.admitted?.binding.connectionId).toBe("state-1");
    expect(processes.signals).toEqual([]);
    expect(await deps.registry.read()).toMatchObject([
      { generation: 1, state: "running", pid: 500 },
    ]);
  });

  it("stops an empty incompatible host (verified PID, no owners, no children)", async () => {
    const { paths } = await rootWith([record({})], [1]);
    const processes = fakeProcesses({ 500: { status: "verified", children: false } });
    const deps = adoptionDeps(paths, {
      probes: { 1: { kind: "incompatible", reason: "major 2" } },
      processes,
    });
    const result = await adoptLocalTerminalHosts(deps);
    expect(processes.signals).toEqual([{ pid: 500, signal: "SIGTERM" }]);
    expect(result.notices).toEqual([]);
    expect(await deps.registry.read()).toEqual([]);
  });

  it("never kills an incompatible host with PTYs; raises a one-time notice", async () => {
    const { paths } = await rootWith([record({})], [1]);
    const processes = fakeProcesses({ 500: { status: "verified", children: true } });
    const deps = adoptionDeps(paths, {
      probes: { 1: { kind: "incompatible", reason: "major 2" } },
      processes,
    });
    const first = await adoptLocalTerminalHosts(deps);
    expect(processes.signals).toEqual([]);
    expect(first.notices).toEqual([
      { generation: 1, reason: "incompatible", firstTime: true, canClose: true },
    ]);
    expect(await deps.registry.read()).toMatchObject([{ state: "draining" }]);
    const second = await adoptLocalTerminalHosts(deps);
    expect(second.notices[0]?.firstTime).toBe(false);
  });

  it("never kills an unreachable host that durable owners reference, even if childless", async () => {
    const { paths } = await rootWith([record({})], [1]);
    const processes = fakeProcesses({ 500: { status: "verified", children: false } });
    const deps = adoptionDeps(paths, {
      probes: { 1: { kind: "unreachable", reason: "handshake timeout" } },
      processes,
      owners: { "state-1": true },
    });
    const result = await adoptLocalTerminalHosts(deps);
    expect(processes.signals).toEqual([]);
    expect(result.notices[0]).toMatchObject({ reason: "unreachable" });
  });

  it("treats an unverifiable PID or an unreadable owner store as live", async () => {
    const { paths } = await rootWith([record({ pid: 600 })], [1]);
    const processes = fakeProcesses({ 600: { status: "mismatch", children: false } });
    const deps = adoptionDeps(paths, {
      probes: { 1: { kind: "incompatible", reason: "major 2" } },
      processes,
    });
    const result = await adoptLocalTerminalHosts(deps);
    expect(processes.signals).toEqual([]);
    expect(result.notices[0]?.canClose).toBe(false);
    const unknownOwners = adoptionDeps(paths, {
      probes: { 1: { kind: "incompatible", reason: "major 2" } },
      processes: fakeProcesses({ 600: { status: "verified", children: false } }),
      owners: { "state-1": undefined },
    });
    await adoptLocalTerminalHosts(unknownOwners);
    expect(unknownOwners.processes.signals).toEqual([]);
  });

  it("adopts through the socket alone after a crash between launch and the final record", async () => {
    const { paths } = await rootWith(
      [record({ state: "launching", pid: undefined, pidStartTime: undefined, epoch: undefined })],
      [1],
    );
    const deps = adoptionDeps(paths, {
      probes: { 1: { kind: "hello", hello: fakeHostHello({ agentEpoch: "epoch-new" }) } },
    });
    const result = await adoptLocalTerminalHosts(deps);
    expect(result.admitted?.binding.expectedEpoch).toBe("epoch-new");
    expect(await deps.registry.read()).toMatchObject([
      { generation: 1, state: "running", epoch: "epoch-new", buildDigest: "digest-a" },
    ]);
  });

  it("rewrites a record for a host found only through its socket", async () => {
    const { paths } = await rootWith([], [4]);
    const deps = adoptionDeps(paths, {
      probes: {
        4: { kind: "hello", hello: fakeHostHello({ processId: 777, processStartTimeMs: 9 }) },
      },
    });
    const result = await adoptLocalTerminalHosts(deps);
    expect(result.admitted?.generation.name).toBe("state-4");
    expect(await deps.registry.read()).toMatchObject([
      { generation: 4, pid: 777, pidStartTime: 9 },
    ]);
  });

  it("removes the record of a host that is gone (no listener)", async () => {
    const { paths } = await rootWith([record({})], [1]);
    const deps = adoptionDeps(paths, { probes: { 1: { kind: "gone" } } });
    const result = await adoptLocalTerminalHosts(deps);
    expect(result.admitted).toBeUndefined();
    expect(await deps.registry.read()).toEqual([]);
  });
});
