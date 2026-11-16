import {
  publicationFixture,
  publicationWiring,
} from "../remote-agent/mobileOptionalPublication.test-fixtures.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import { ServerSettingsMobileConsentGuard } from "../ws/serverSettings.mobileConsent.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { RemoteMobileConsentGuardLive } from "./mobileConsentRevoke.ts";
import { assertLocalSupervisorBackendReservation } from "./localSupervisorAuthority.ts";

type Fixture = Awaited<ReturnType<typeof publicationFixture>>;
let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});
async function guard(f: Fixture) {
  const base = ServerConfig.layerTest(f.home, join(f.home, "settings-config")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const config = Layer.effect(
    ServerConfig,
    Effect.map(Effect.service(ServerConfig), (value) => ({
      ...value,
      mode: "remote" as const,
      stateDir: f.stateDir,
    })),
  ).pipe(Layer.provide(base));
  return Effect.runPromise(
    Effect.service(ServerSettingsMobileConsentGuard).pipe(
      Effect.provide(
        RemoteMobileConsentGuardLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              config,
              Layer.succeed(BackendInstance, f.owner()),
              Layer.succeed(RemoteBackendIdentityService, f.identity),
            ),
          ),
        ),
      ),
    ),
  );
}
async function seedPrivateRegistry(f: Fixture) {
  const directory = join(f.control.root, "control-v1");
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(join(directory, "registry.json"), JSON.stringify(f.read()), { mode: 0o600 });
}

it("commits separate consent off through the real owner without changing base or other-client pins", async () => {
  const f = (fixture = await publicationFixture());
  const before = f.read();
  f.replaceState({ ...before, pins: [{ owner: "other-client", buildId: before.current! }] });
  await seedPrivateRegistry(f);
  const policy = await guard(f);
  await Effect.runPromise(policy.revoke);
  const after = f.read();
  expect(after.schemaVersion).toBe(3);
  if (after.schemaVersion !== 3 || before.schemaVersion !== 3)
    throw new Error("Missing v3 fixture");
  expect(after.mobile.consent).toEqual({
    enabled: false,
    revision: before.mobile.consent.revision + 1,
  });
  expect(after.builds).toEqual(before.builds);
  expect(after.current).toBe(before.current);
  expect(after.pins).toEqual([{ owner: "other-client", buildId: before.current }]);
  const revision = after.revision;
  await Effect.runPromise(policy.revoke);
  expect(f.read().revision).toBe(revision);
});

it("performs no control command or directory creation when no durable mobile registry exists", async () => {
  const f = (fixture = await publicationFixture());
  const policy = await guard(f);
  publicationWiring.before = async () => {
    throw new Error("No control command expected");
  };
  await Effect.runPromise(policy.revoke);
  await expect(fs.lstat(join(f.control.root, "control-v1"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("refuses a missing reservation before changing consent", async () => {
  const f = (fixture = await publicationFixture());
  await seedPrivateRegistry(f);
  const policy = await guard(f);
  await fs.unlink(join(f.control.root, "account-authority-v1"));
  await expect(Effect.runPromise(policy.revoke)).rejects.toThrow("could not be revoked");
  const after = f.read();
  expect(after.schemaVersion === 3 && after.mobile.consent.enabled).toBe(true);
});

it("requires the existing reservation to match the exact locked backend state", async () => {
  const f = (fixture = await publicationFixture());
  await expect(
    assertLocalSupervisorBackendReservation(f.control, f.identity, f.stateDir),
  ).resolves.toBeUndefined();
  await expect(
    assertLocalSupervisorBackendReservation(f.control, f.identity, join(f.home, "other-state")),
  ).rejects.toThrow("another backend state");
});

it("waits for a cancelled accepted CAS command before returning its owner scope", async () => {
  const f = (fixture = await publicationFixture());
  await seedPrivateRegistry(f);
  const policy = await guard(f);
  let entered = false;
  let release!: () => void;
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  publicationWiring.before = async () => {
    entered = true;
    await finish;
  };
  const controller = new AbortController();
  let settled = false;
  const task = Effect.runPromise(policy.revoke, { signal: controller.signal }).finally(() => {
    settled = true;
  });
  void task.catch(() => {});
  try {
    await expect.poll(() => entered, { timeout: 2000 }).toBe(true);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    release();
    await expect(task).rejects.toThrow();
    expect(settled).toBe(true);
  } finally {
    release();
    await task.catch(() => {});
  }
});
