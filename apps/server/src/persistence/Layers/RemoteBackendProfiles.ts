import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import {
  RemoteBackendProfileConflict,
  RemoteBackendProfileRecord,
  RemoteBackendProfiles,
  type RemoteBackendProfilesShape,
} from "../Services/RemoteBackendProfiles.ts";

type Row = Omit<RemoteBackendProfileRecord, "bootEnabled"> & { bootEnabled: number };

const columns = (sql: SqlClient.SqlClient) => sql`profile_id AS "profileId",
  request_id AS "requestId", execution_target_id AS "executionTargetId", label,
  authority_id AS "authorityId", key_fingerprint AS "keyFingerprint", key_epoch AS "keyEpoch",
  installation_fingerprint AS "installationFingerprint", host_identity AS "hostIdentity",
  remote_home AS "remoteHome", graph_version AS "graphVersion", graph_target AS "graphTarget",
  graph_archive_sha256 AS "graphArchiveSha256", graph_manifest_sha256 AS "graphManifestSha256",
  graph_root AS "graphRoot", node_binary AS "nodeBinary", node_sha256 AS "nodeSha256",
  helper_entry AS "helperEntry", helper_sha256 AS "helperSha256",
  boot_enabled AS "bootEnabled", created_at AS "createdAt"`;

const sameRecord = (a: RemoteBackendProfileRecord, b: RemoteBackendProfileRecord) =>
  (Object.keys(a) as Array<keyof RemoteBackendProfileRecord>).every((key) => a[key] === b[key]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decode = (row: Row) =>
    Effect.try({
      try: () =>
        Schema.decodeUnknownSync(RemoteBackendProfileRecord)({
          ...row,
          bootEnabled: row.bootEnabled === 1,
        }),
      catch: toPersistenceDecodeCauseError("RemoteBackendProfiles.decode"),
    });
  const one = (rows: ReadonlyArray<Row>) => (rows[0] ? decode(rows[0]) : Effect.undefined);
  const get: RemoteBackendProfilesShape["get"] = Effect.fn("RemoteBackendProfiles.get")(
    function* (profileId) {
      const rows = yield* sql<Row>`SELECT ${columns(sql)} FROM remote_backend_profiles
        WHERE profile_id = ${profileId}`.pipe(
        Effect.mapError(toPersistenceSqlError("RemoteBackendProfiles.get")),
      );
      return yield* one(rows);
    },
  );
  const findByRequestId: RemoteBackendProfilesShape["findByRequestId"] = Effect.fn(
    "RemoteBackendProfiles.findByRequestId",
  )(function* (requestId) {
    const rows = yield* sql<Row>`SELECT ${columns(sql)} FROM remote_backend_profiles
      WHERE request_id = ${requestId}`.pipe(
      Effect.mapError(toPersistenceSqlError("RemoteBackendProfiles.findByRequestId")),
    );
    return yield* one(rows);
  });
  const findByTarget: RemoteBackendProfilesShape["findByTarget"] = Effect.fn(
    "RemoteBackendProfiles.findByTarget",
  )(function* (executionTargetId) {
    const rows = yield* sql<Row>`SELECT ${columns(sql)} FROM remote_backend_profiles
      WHERE execution_target_id = ${executionTargetId} ORDER BY created_at DESC LIMIT 1`.pipe(
      Effect.mapError(toPersistenceSqlError("RemoteBackendProfiles.findByTarget")),
    );
    return yield* one(rows);
  });
  return {
    get,
    findByRequestId,
    findByTarget,
    list: Effect.fn("RemoteBackendProfiles.list")(function* () {
      const rows = yield* sql<Row>`SELECT ${columns(sql)} FROM remote_backend_profiles
        ORDER BY created_at, profile_id LIMIT 64`.pipe(
        Effect.mapError(toPersistenceSqlError("RemoteBackendProfiles.list")),
      );
      return yield* Effect.forEach(rows, decode);
    }),
    insert: Effect.fn("RemoteBackendProfiles.insert")(function* (input) {
      const r = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(RemoteBackendProfileRecord)(input),
        catch: toPersistenceDecodeCauseError("RemoteBackendProfiles.insert"),
      });
      yield* sql`INSERT INTO remote_backend_profiles (
          profile_id, request_id, execution_target_id, label, authority_id, key_fingerprint,
          key_epoch, installation_fingerprint, host_identity, remote_home, graph_version,
          graph_target, graph_archive_sha256, graph_manifest_sha256, graph_root, node_binary,
          node_sha256, helper_entry, helper_sha256, boot_enabled, created_at
        ) VALUES (${r.profileId}, ${r.requestId}, ${r.executionTargetId}, ${r.label},
          ${r.authorityId}, ${r.keyFingerprint}, ${r.keyEpoch}, ${r.installationFingerprint},
          ${r.hostIdentity}, ${r.remoteHome}, ${r.graphVersion}, ${r.graphTarget},
          ${r.graphArchiveSha256}, ${r.graphManifestSha256}, ${r.graphRoot}, ${r.nodeBinary},
          ${r.nodeSha256}, ${r.helperEntry}, ${r.helperSha256}, ${r.bootEnabled ? 1 : 0},
          ${r.createdAt})
        ON CONFLICT DO NOTHING`.pipe(
        Effect.mapError(toPersistenceSqlError("RemoteBackendProfiles.insert")),
      );
      const stored = yield* get(r.profileId);
      if (!stored || !sameRecord(stored, r))
        return yield* new RemoteBackendProfileConflict({
          detail: "A different remote backend profile already holds this identity or request.",
        });
      return stored;
    }),
  } satisfies RemoteBackendProfilesShape;
});

export const RemoteBackendProfilesLive = Layer.effect(RemoteBackendProfiles, make);
