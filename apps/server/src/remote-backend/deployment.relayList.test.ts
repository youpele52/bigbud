import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, it } from "vitest";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { RemoteBackendProfilesLive } from "../persistence/Layers/RemoteBackendProfiles.ts";
import { RemoteBackendProfiles } from "../persistence/Services/RemoteBackendProfiles.ts";
import { makeRemoteBackendRelayLeases } from "./clientRelay.leases.ts";
import { makePersistedRemoteBackendRelayProfiles } from "./deployment.profiles.store.ts";
import { makeRemoteBackendDeployment } from "./deployment.ts";
import type { DeploymentProfileStore } from "./deployment.types.ts";
import {
  AUTHORITY,
  INSTALLATION,
  KEY_FINGERPRINT,
  makeDeploymentFixture,
  REQUEST,
  TARGET,
  type DeploymentFixture,
} from "./deployment.test.helpers.ts";

const fixtures: DeploymentFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
const never = new AbortController().signal;

it("relay_list_returns_available_after_setup", async () => {
  const fixture = await makeDeploymentFixture();
  fixtures.push(fixture);
  const graph = await fixture.graph("1.0.0");
  const program = Effect.gen(function* () {
    yield* runMigrations();
    const repository = yield* RemoteBackendProfiles;
    const run = Effect.runPromiseWith(yield* Effect.services());
    const store: DeploymentProfileStore = {
      list: () => run(repository.list()),
      get: (id) => run(repository.get(id)),
      findByRequestId: (id) => run(repository.findByRequestId(id)),
      findByTarget: (target) => run(repository.findByTarget(target)),
      insert: (record) => run(repository.insert(record)),
    };
    const directory = makePersistedRemoteBackendRelayProfiles(store);
    const leases = makeRemoteBackendRelayLeases({
      profiles: directory,
      isCallerActive: async () => true,
      openProfile: async () => {
        throw new Error("not opened in this test");
      },
    });
    return yield* Effect.promise(async () => {
      const before = await leases.list("caller", never);
      const deployment = makeRemoteBackendDeployment({
        approval: async () => ({ approved: true }),
        assertHostTrusted: async () => {},
        run: fixture.run,
        resolveSource: async () => graph,
        store,
      });
      const result = await deployment.setupRemoteBackend(
        { executionTargetId: TARGET, requestId: REQUEST, enableBoot: false },
        never,
      );
      const after = await leases.list("caller", never);
      const resolved = await directory.resolve(result.profileId, "caller", never);
      const missing = await directory.resolve("rb-missing", "caller", never).catch((e) => e);
      await leases.dispose();
      return { before, after, resolved, missing, result };
    });
  });
  const { before, after, resolved, missing, result } = await Effect.runPromise(
    program.pipe(
      Effect.provide(
        RemoteBackendProfilesLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
      ),
    ),
  );
  expect(before).toEqual({ availability: "setup-required", profiles: [] });
  expect(after).toEqual({
    availability: "available",
    profiles: [
      {
        profileId: result.profileId,
        label: "dev@vps.example",
        identity: {
          authority: { authorityId: AUTHORITY, keyEpoch: 1, keyFingerprint: KEY_FINGERPRINT },
          installationFingerprint: INSTALLATION,
        },
      },
    ],
  });
  expect(JSON.stringify(after)).not.toContain(fixture.home);
  expect(resolved.executionTargetId).toBe(TARGET);
  expect(resolved.deployment.helperEntry).toMatch(/remoteBackendClientRelay\.mjs$/);
  expect(missing).toMatchObject({ code: "not-found" });
});
