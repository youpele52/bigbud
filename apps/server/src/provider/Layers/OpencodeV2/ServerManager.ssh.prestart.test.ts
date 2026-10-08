import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { OpencodeV2ServerManager } from "./ServerManager.ts";
import { startOwnedV2SshProcess } from "./ServerManager.ssh.ts";
import { makeOwnedClient } from "./Client.ts";
import { FixtureEvents } from "./Test.fixtures.ts";

for (const kind of ["ENOENT", "EACCES"] as const) {
  it(`actual local SSH spawn ${kind} is proven prestart, permits corrected same-profile retry and confirmed shutdown`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bigbud-v2-ssh-prestart-"));
    const executable = path.join(directory, "ssh");
    if (kind === "EACCES") await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    const source = new FixtureEvents();
    let corrected = false,
      starts = 0,
      exited = false;
    const manager = new OpencodeV2ServerManager({
      maxProcesses: 1,
      maxOwners: 25,
      maxQueuedEvents: 4,
      maxEventBytes: 1024,
      consumerTimeoutMs: 100,
      start: async (config) => {
        starts++;
        if (!corrected)
          return startOwnedV2SshProcess(config, {
            protectedBootstrapConformance: true,
            spawn: ((_command: string, args: string[], options: Parameters<typeof spawn>[2]) =>
              spawn(executable, args, options)) as unknown as typeof spawn,
          });
        return {
          client: {
            ...makeOwnedClient({ endpoint: "http://127.0.0.1:4000", password: "synthetic" }),
            event: {
              subscribe: (options) =>
                source.subscribe(options?.signal ?? new AbortController().signal),
            },
          },
          isRunning: () => !exited,
          hasExited: () => exited,
          onDeath: () => () => {},
          close: async () => {
            exited = true;
          },
        };
      },
    });
    const config = {
      runtimeTargetId: "ssh:host=fixture.invalid&user=fixture&auth=ssh-key",
      binaryPath: "/native/v2",
      profileRoot: "/same/profile",
    };
    try {
      await expect(manager.acquire(config)).rejects.toThrow("acquisition failed");
      expect((manager as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
      corrected = true;
      const lease = await manager.acquire({ ...config, binaryPath: "/corrected/v2" });
      expect(starts).toBe(2);
      await lease.release();
      await expect(manager.close()).resolves.toBeUndefined();
    } finally {
      await manager.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
