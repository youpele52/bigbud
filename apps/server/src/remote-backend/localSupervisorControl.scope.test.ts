import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import { scopeLocalSupervisorControl } from "./localSupervisorControl.scope.ts";
import { makeLocalSupervisorBootReconciler } from "./localSupervisorService.boot.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});
async function fixture() {
  const homeDir = await fs.realpath(await fs.mkdtemp("/tmp/bc-"));
  homes.push(homeDir);
  const execute = vi.fn<NonNullable<Parameters<typeof makeLocalSupervisorControl>[0]["execute"]>>(
    async (_command, _args, _options) => ({
      code: 0,
      signal: null,
      timedOut: false,
      stdout: "missing",
      stderr: "",
    }),
  );
  const control = makeLocalSupervisorControl({
    homeDir,
    targetId: `remote-backend:${"a".repeat(32)}`,
    execute,
  });
  return { control, execute };
}

describe("finite local supervisor command scope", () => {
  it("propagates the same abort scope into registry transport and refuses later commands", async () => {
    const f = await fixture();
    const abort = new AbortController();
    const scoped = scopeLocalSupervisorControl(f.control, abort.signal);
    const opened = await scoped.openControl(scoped.targetId);
    expect((await opened.registry.read()).builds).toEqual([]);
    expect(f.execute.mock.calls[0]?.[2].signal).toBe(abort.signal);
    abort.abort();
    await expect(opened.registry.read()).rejects.toBeDefined();
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it("an already aborted scope cannot create an agent root", async () => {
    const f = await fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(
      scopeLocalSupervisorControl(f.control, abort.signal).openControl(f.control.targetId),
    ).rejects.toBeDefined();
    await expect(fs.lstat(f.control.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("boot refuses an unclaimed account before registry creation or durable SQL owner reads", async () => {
    const f = await fixture();
    const owners: RemoteAgentOwnerStore = {
      getBinding: vi.fn(async () => undefined),
      bindConnection: vi.fn(async () => undefined),
      get: async () => undefined,
      reserve: async (owner) => owner,
      update: async () => {
        throw new Error("must not update");
      },
      referencedBuildIds: async () => new Set(),
    };
    const boot = makeLocalSupervisorBootReconciler({
      control: f.control,
      owners,
      configPath: join(f.control.homeDir, "unused"),
      identity: {
        authority: {
          authorityId: "a".repeat(32),
          keyEpoch: 1,
          keyFingerprint: `sha256:${"b".repeat(64)}`,
        },
        installationFingerprint: `sha256:${"c".repeat(64)}`,
      },
    });
    try {
      await expect(boot.reconcile(new AbortController().signal)).rejects.toBeDefined();
      expect(owners.getBinding).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      await expect(fs.lstat(f.control.root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      boot.close();
    }
  });
});
