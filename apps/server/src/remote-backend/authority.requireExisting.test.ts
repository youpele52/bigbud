import * as fs from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireStateDirLock,
  type StateDirLockHandle,
  type StateDirLockProbe,
} from "../startup/stateDirLock.ts";
import { BackendInstance, makeBackendInstance } from "../startup/backendInstance.ts";
import { loadRemoteBackendIdentity } from "./authority.ts";
import { AUTHORITY_FILENAME } from "./authority.files.ts";
import {
  makeRemoteBackendIdentityLive,
  RemoteBackendIdentityLive,
  RemoteBackendIdentityService,
} from "./identity.service.ts";

const fixtures: { root: string; handle: StateDirLockHandle }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.handle.release();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/be-"));
  const probe: StateDirLockProbe = {
    pid: process.pid,
    hostname: () => "fixture-host",
    machineId: () => "machine-v1:fixture",
    isAlive: (pid) => pid === process.pid,
    startToken: () => "fixture-start",
  };
  const handle = await acquireStateDirLock({ stateDir: root, port: 49321, probe });
  fixtures.push({ root, handle });
  return {
    root,
    handle,
    owner: makeBackendInstance(handle, root, probe),
    path: join(root, AUTHORITY_FILENAME),
  };
}

describe.runIf(process.platform !== "win32")(
  "existing service authority under the real backend lock",
  () => {
    it("refuses a missing identity without generating a key through the strict service layer", async () => {
      const f = await fixture();
      const program = Effect.service(RemoteBackendIdentityService).pipe(
        Effect.provide(
          makeRemoteBackendIdentityLive({ requireExisting: true }).pipe(
            Layer.provide(Layer.succeed(BackendInstance, f.owner)),
          ),
        ),
      );
      await expect(Effect.runPromise(program)).rejects.toThrow("authority is missing");
      expect(await fs.readdir(f.root)).toEqual(["backend.lock"]);
      await f.owner.assertHeld();
    });
    it("keeps explicit setup creation but never replaces a deleted claimed identity", async () => {
      const f = await fixture();
      const first = await Effect.runPromise(
        Effect.service(RemoteBackendIdentityService).pipe(
          Effect.provide(
            RemoteBackendIdentityLive.pipe(Layer.provide(Layer.succeed(BackendInstance, f.owner))),
          ),
        ),
      );
      expect(
        (await loadRemoteBackendIdentity(f.owner, { requireExisting: true })).authority,
      ).toEqual(first.authority);
      await fs.unlink(f.path);
      await expect(loadRemoteBackendIdentity(f.owner, { requireExisting: true })).rejects.toThrow(
        "no replacement identity was generated",
      );
      expect(await fs.readdir(f.root)).toEqual(["backend.lock"]);
    });
    it("does not bypass lock ownership merely because an existing key is present", async () => {
      const f = await fixture();
      await loadRemoteBackendIdentity(f.owner);
      const original = await fs.readFile(f.path);
      await f.handle.release();
      await expect(loadRemoteBackendIdentity(f.owner, { requireExisting: true })).rejects.toThrow(
        "lock is no longer held",
      );
      expect((await fs.readFile(f.path)).equals(original)).toBe(true);
    });
    it("never coalesces strict loading into a pending create-capable initialization", async () => {
      const f = await fixture();
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const starting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const creating = loadRemoteBackendIdentity({
        ...f.owner,
        assertHeld: async () => {
          entered();
          await gate;
          await f.owner.assertHeld();
        },
      });
      await starting;
      let result: string;
      try {
        result = await Promise.race([
          loadRemoteBackendIdentity(f.owner, { requireExisting: true }).then(
            () => "unexpected-create",
            () => "missing",
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve("coalesced"), 100)),
        ]);
      } finally {
        release();
        await creating;
      }
      expect(result).toBe("missing");
    });
  },
);
