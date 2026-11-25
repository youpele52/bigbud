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
  it("handshakes in production mode with the derived profile, state dir and fixed facts only", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    vi.stubEnv("BIGBUD_TEST_ENV_SENTINEL", "leak");
    vi.stubEnv("BIGBUD_SSH_OWNER_PICKER_PROOF", "1");
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const observation = yield* Effect.promise(() => fixture.observation());
        expect(handle.mode).toBe("spawned");
        expect(handle.state()).toBe("open");
        expect(handle.ownerEpoch).toHaveLength(32);
        const facts = resolveSshOwnerLaunchFacts(profileOf(fixture));
        // Cleared environment: neither the caller sentinel nor the old proof
        // environment reaches the production owner.
        expect(observation.env).not.toHaveProperty("BIGBUD_TEST_ENV_SENTINEL");
        expect(observation.env).not.toHaveProperty("BIGBUD_SSH_OWNER_PICKER_PROOF");
        expect(observation.argv[2]).toBe("--production");
        expect(observation.argv[3]).toBe("--profile");
        expect(observation.argv[4]).toBe(facts.profileBindingText);
        expect(observation.argv[5]).toBe("--state-dir");
        expect(observation.argv[6]).toBe(fixture.stateDirectory);
        expect(observation.argv.slice(7, 15)).toEqual([
          facts.targetId,
          "/usr/bin/ssh",
          "/usr/bin/ssh-keyscan",
          "127.0.0.1",
          "2222",
          "tester",
          facts.identityFile,
          facts.knownHostsFile,
        ]);
        expect(observation.argv[15]).toBe("--attach-socket");
        expect(observation.argv).toHaveLength(17);
        const descriptor = yield* Effect.promise(() =>
          readSshOwnerAttachmentDescriptor(
            resolveSshOwnerLaunchFacts(profileOf(fixture)).attachFile,
          ),
        );
        expect(descriptor).toMatchObject({
          version: 1,
          profileBinding: facts.profileBindingText,
        });
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
