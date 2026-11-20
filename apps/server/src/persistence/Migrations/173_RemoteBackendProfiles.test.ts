import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { RemoteBackendProfilesLive } from "../Layers/RemoteBackendProfiles.ts";
import {
  RemoteBackendProfiles,
  type RemoteBackendProfileRecord,
} from "../Services/RemoteBackendProfiles.ts";

const record: RemoteBackendProfileRecord = {
  profileId: `rb-${"a".repeat(32)}`,
  requestId: "11111111-2222-4333-8444-555555555555",
  executionTargetId: "ssh:host=vps.example&user=dev&transport=agent",
  label: "dev@vps.example",
  authorityId: "a".repeat(32),
  keyFingerprint: `sha256:${"b".repeat(64)}`,
  keyEpoch: 1,
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  hostIdentity: `sha256:${"d".repeat(64)}`,
  remoteHome: "/home/dev",
  graphVersion: "1.0.0",
  graphTarget: "aarch64-unknown-linux-gnu",
  graphArchiveSha256: "e".repeat(64),
  graphManifestSha256: "f".repeat(64),
  graphRoot: "/home/dev/.bigbud/backend-graphs/g/graph",
  nodeBinary: "/home/dev/.bigbud/backend-graphs/g/graph/runtime/node",
  nodeSha256: "1".repeat(64),
  helperEntry: "/home/dev/.bigbud/backend-graphs/g/graph/server/remote-client-relay/r.mjs",
  helperSha256: "2".repeat(64),
  bootEnabled: false,
  createdAt: "2026-11-17T00:00:00.000Z",
};

it.effect("173 creates the remote backend profile directory on upgrade", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 172 });
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'remote_backend_profiles'`,
      [],
    );
    yield* runMigrations({ toMigrationInclusive: 173 });
    const columns = (yield* sql<{ name: string }>`PRAGMA table_info(remote_backend_profiles)`).map(
      (column) => column.name,
    );
    assert.includeMembers(columns, [
      "authority_id",
      "key_fingerprint",
      "installation_fingerprint",
      "host_identity",
      "graph_version",
      "node_sha256",
      "helper_sha256",
    ]);
    const profiles = yield* RemoteBackendProfiles;
    assert.deepStrictEqual(yield* profiles.insert(record), record);
    // Identical replay is idempotent; a different request for the same authority conflicts.
    assert.deepStrictEqual(yield* profiles.insert(record), record);
    const conflict = yield* Effect.flip(
      profiles.insert({ ...record, profileId: "rb-other", requestId: "other" }),
    );
    assert.equal(conflict._tag, "RemoteBackendProfileConflict");
    assert.deepStrictEqual(yield* profiles.list(), [record]);
    assert.deepStrictEqual(yield* profiles.findByRequestId(record.requestId), record);
    assert.deepStrictEqual(yield* profiles.findByTarget(record.executionTargetId), record);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 173 }), []);
  }).pipe(
    Effect.provide(
      RemoteBackendProfilesLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
    ),
  ),
);
