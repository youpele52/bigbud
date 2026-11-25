import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import type { SshOwnerProductionProfile } from "./sshOwnerProductionClient.launch.ts";
import { readSshOwnerAttachmentDescriptor } from "./sshOwnerProductionClient.attachment.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import {
  killIfAlive,
  makeProductionFixture,
  waitForDeath,
  type ProductionFixture,
} from "./sshOwnerProductionClient.fixture.ts";

type Sql = SqlClient.SqlClient;

function profileOf(fixture: ProductionFixture, overrides: Partial<SshOwnerProductionProfile> = {}) {
  return { ...fixture.profile, ...overrides } satisfies SshOwnerProductionProfile;
}

async function withPersistence<A, E>(
  fixture: ProductionFixture,
  run: (sql: Sql) => Effect.Effect<A, E>,
): Promise<A> {
  const layer = makeSqlitePersistenceLive(join(fixture.stateDirectory, "state.sqlite"), {
    worker: false,
  }).pipe(Layer.provide(NodeServices.layer));
  return Effect.runPromise(
    Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
      Effect.provideService(run(sql), SqlClient.SqlClient, sql),
    ).pipe(Effect.provide(layer)),
  );
}

const start = (fixture: ProductionFixture, sql: Sql, path: string, deadlineMs?: number) =>
  startOrAttachSshOwnerProduction({
    artifact: fixture.artifact(path),
    facts: resolveSshOwnerLaunchFacts(profileOf(fixture)),
    sql,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const fn of cleanup.splice(0)) await fn();
});

describe("production owner client spawn", () => {
  it("handshakes, keeps a private env allowlist, and never accepts caller argv or shell", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    vi.stubEnv("BIGBUD_TEST_ENV_SENTINEL", "leak");
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const observation = yield* Effect.promise(() => fixture.observation());
        expect(handle.mode).toBe("spawned");
        expect(handle.state()).toBe("open");
        expect(handle.ownerEpoch).toHaveLength(32);
        // Cleared environment plus the explicit production allowlist. macOS adds
        // one non-secret process-encoding value; caller variables must not leak.
        const allowed = ["BIGBUD_SSH_OWNER_PICKER_PROOF"];
        if (process.platform === "darwin") allowed.push("__CF_USER_TEXT_ENCODING");
        expect(Object.keys(observation.env).toSorted()).toEqual(allowed.toSorted());
        expect(observation.env.BIGBUD_SSH_OWNER_PICKER_PROOF).toBe("1");
        expect(observation.env).not.toHaveProperty("BIGBUD_TEST_ENV_SENTINEL");
        // No caller-supplied argv tail, no shell wrapper: profile plus the ten
        // fixed launch facts plus the owned attachment socket pair.
        expect(observation.argv.slice(2)).toHaveLength(12);
        expect(observation.argv[2]).toMatch(/^[0-9a-f]{64}$/);
        expect(observation.argv[5]).toBe("/usr/bin/ssh");
        expect(observation.argv[6]).toBe("/usr/bin/ssh-keyscan");
        expect(observation.argv[12]).toBe("--attach-socket");
        const descriptor = yield* Effect.promise(() =>
          readSshOwnerAttachmentDescriptor(
            resolveSshOwnerLaunchFacts(profileOf(fixture)).attachFile,
          ),
        );
        expect(descriptor).toMatchObject({ version: 1 });
        expect(descriptor?.capability).toHaveLength(32);
        yield* handle.hydrate({
          durableDisconnects: [],
          aliasDescriptorBindings: [],
          retirementMirror: [],
          paneBindings: [],
        });
        const pid = observation.pid;
        cleanup.push(async () => killIfAlive(pid));
      }),
    );
  });

  it("bounds startup with a typed timeout and kills the child", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("silent");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const failure = yield* start(fixture, sql, path, 300).pipe(Effect.flip);
        expect(failure).toMatchObject({ failure: "startup-timeout" });
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* Effect.promise(() => waitForDeath(observation.pid));
        expect(observation.pid).toBeGreaterThan(0);
      }),
    );
  });

  it("rejects a protocol version mismatch and shuts the child down", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("version-mismatch");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const failure = yield* start(fixture, sql, path).pipe(Effect.flip);
        expect(failure).toMatchObject({ failure: "version-incompatible" });
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* Effect.promise(() => waitForDeath(observation.pid));
      }),
    );
  });

  it("rejects a missing required capability and shuts the child down", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const failure = yield* startOrAttachSshOwnerProduction({
          artifact: fixture.artifact(path),
          facts: resolveSshOwnerLaunchFacts(profileOf(fixture)),
          sql,
          requiredCapabilities: ["wire.v1", "peer.enrollment"],
        }).pipe(Effect.flip);
        expect(failure).toMatchObject({ failure: "capability-missing" });
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* Effect.promise(() => waitForDeath(observation.pid));
      }),
    );
  });

  it("rejects an oversized owner frame as a typed protocol failure", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("oversized");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const failure = yield* start(fixture, sql, path, 1_500).pipe(Effect.flip);
        expect(failure).toMatchObject({ failure: "wire-protocol-invalid" });
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* Effect.promise(() => waitForDeath(observation.pid));
      }),
    );
  });
});
