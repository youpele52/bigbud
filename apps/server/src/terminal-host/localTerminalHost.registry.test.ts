import { lstat, readdir, writeFile, mkdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  makeLocalTerminalHostRegistry,
  upsertLocalTerminalHostRecord,
  type LocalTerminalHostRecord,
} from "./localTerminalHost.registry.ts";
import { makeShortTerminalHostRoot } from "./localTerminalHost.testUtils.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const provisional: LocalTerminalHostRecord = {
  generation: 1,
  state: "launching",
  binaryPath: "/tmp/bin",
  capabilities: [],
  launchedAt: 1,
};

describe("local terminal host registry", () => {
  it("writes a provisional record then the final one, atomically and 0600", async () => {
    const { paths, cleanup } = await makeShortTerminalHostRoot();
    cleanups.push(cleanup);
    const registry = makeLocalTerminalHostRegistry(paths);
    await registry.update((records) => upsertLocalTerminalHostRecord(records, provisional));
    expect(await registry.read()).toEqual([provisional]);
    expect((await lstat(paths.hostsFile)).mode & 0o777).toBe(0o600);
    await registry.update((records) =>
      upsertLocalTerminalHostRecord(records, {
        ...provisional,
        state: "running",
        pid: 4242,
        pidStartTime: 10,
        epoch: "e1",
      }),
    );
    expect(await registry.read()).toMatchObject([{ generation: 1, state: "running", pid: 4242 }]);
    expect((await readdir(paths.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes concurrent updates without losing a generation", async () => {
    const { paths, cleanup } = await makeShortTerminalHostRoot();
    cleanups.push(cleanup);
    const registry = makeLocalTerminalHostRegistry(paths);
    await Promise.all(
      [1, 2, 3].map((generation) =>
        registry.update((records) =>
          upsertLocalTerminalHostRecord(records, { ...provisional, generation }),
        ),
      ),
    );
    expect((await registry.read()).map((record) => record.generation)).toEqual([1, 2, 3]);
  });

  it("treats a corrupt file as no records (PIDs unverifiable, hosts kept)", async () => {
    const { paths, cleanup } = await makeShortTerminalHostRoot();
    cleanups.push(cleanup);
    await mkdir(paths.root, { mode: 0o700 });
    await writeFile(paths.hostsFile, "{not json");
    const corrupt: Array<unknown> = [];
    const registry = makeLocalTerminalHostRegistry(paths, (cause) => corrupt.push(cause));
    expect(await registry.read()).toEqual([]);
    expect(corrupt).toHaveLength(1);
  });
});
