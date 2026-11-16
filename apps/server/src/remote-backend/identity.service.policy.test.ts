import * as fs from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, it } from "vitest";
import { ServerConfig, type ServerConfigShape } from "../startup/config.ts";
import { BackendInstance, makeBackendInstance } from "../startup/backendInstance.ts";
import { acquireStateDirLock, type StateDirLockHandle } from "../startup/stateDirLock.ts";
import { loadRemoteBackendIdentity } from "./authority.ts";
import { AUTHORITY_FILENAME } from "./authority.files.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import {
  bindAccountServiceIdentity,
  RemoteBackendIdentityForServerLive,
} from "./identity.service.policy.ts";

const fixtures: { root: string; handle: StateDirLockHandle }[] = [];
afterEach(async () => {
  for (const { root, handle } of fixtures.splice(0)) {
    await handle.release();
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/be-policy-"));
  const probe = {
    pid: process.pid,
    hostname: () => "fixture",
    machineId: () => "machine-v1:policy",
    isAlive: (pid: number) => pid === process.pid,
    startToken: () => "fixture-start",
  };
  const handle = await acquireStateDirLock({ stateDir: root, port: 49321, probe });
  fixtures.push({ root, handle });
  const owner = makeBackendInstance(handle, root, probe);
  // This layer only consumes mode and object identity; persistence/runtime are outside this test.
  const config = { mode: "remote" } as ServerConfigShape;
  const load = () =>
    Effect.runPromise(
      Effect.service(RemoteBackendIdentityService).pipe(
        Effect.provide(
          RemoteBackendIdentityForServerLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ServerConfig, config),
                Layer.succeed(BackendInstance, owner),
              ),
            ),
          ),
        ),
      ),
    );
  return { root, owner, config, load, path: join(root, AUTHORITY_FILENAME) };
}
it("preserves explicit fresh remote setup and reloads the same bound identity", async () => {
  const f = await fixture();
  const first = await f.load();
  expect(bindAccountServiceIdentity(f.config, first)).toBe(f.config);
  expect((await f.load()).authority).toEqual(first.authority);
});
it("refuses a key lost between finite preflight and main startup without replacement", async () => {
  const f = await fixture();
  bindAccountServiceIdentity(f.config, await f.load());
  await fs.unlink(f.path);
  await expect(f.load()).rejects.toThrow("no replacement identity was generated");
  expect(await fs.readdir(f.root)).toEqual(["backend.lock"]);
});
it("refuses a valid replacement identity in the main startup handoff", async () => {
  const f = await fixture();
  bindAccountServiceIdentity(f.config, await f.load());
  await fs.unlink(f.path);
  await loadRemoteBackendIdentity(f.owner);
  const replaced = await fs.readFile(f.path);
  await expect(f.load()).rejects.toThrow("identity changed after preflight");
  expect(await fs.readFile(f.path)).toEqual(replaced);
});
it("snapshots the public policy and refuses rebinding", async () => {
  const f = await fixture();
  const identity = await f.load();
  const pin = {
    authority: { ...identity.authority },
    installationFingerprint: identity.installationFingerprint,
  };
  bindAccountServiceIdentity(f.config, pin);
  pin.authority.authorityId = "f".repeat(32);
  expect((await f.load()).authority).toEqual(identity.authority);
  expect(() => bindAccountServiceIdentity(f.config, identity)).toThrow("unbound remote");
});
