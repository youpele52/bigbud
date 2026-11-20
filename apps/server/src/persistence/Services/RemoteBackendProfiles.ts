import { Schema, ServiceMap } from "effect";
import type * as Effect from "effect/Effect";
import {
  RemoteBackendAuthorityId,
  RemoteBackendSha256Fingerprint,
} from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import { RemoteBackendRelayProfileId } from "@bigbud/contracts/server/remoteBackendRelay.ts";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

const Bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Hex64 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const RemotePath = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(/^\/[A-Za-z0-9._/@+-]*$/),
);

/**
 * One deployed remote backend: its pinned authority/installation identity, SSH host identity and
 * the verified graph the laptop relay executes. Written only by laptop-driven deployment.
 */
export const RemoteBackendProfileRecord = Schema.Struct({
  profileId: RemoteBackendRelayProfileId,
  requestId: Bounded,
  executionTargetId: Bounded,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  authorityId: RemoteBackendAuthorityId,
  keyFingerprint: RemoteBackendSha256Fingerprint,
  keyEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  installationFingerprint: RemoteBackendSha256Fingerprint,
  hostIdentity: RemoteBackendSha256Fingerprint,
  remoteHome: RemotePath,
  graphVersion: Bounded,
  graphTarget: Bounded,
  graphArchiveSha256: Hex64,
  graphManifestSha256: Hex64,
  graphRoot: RemotePath,
  nodeBinary: RemotePath,
  nodeSha256: Hex64,
  helperEntry: RemotePath,
  helperSha256: Hex64,
  bootEnabled: Schema.Boolean,
  createdAt: Bounded,
});
export type RemoteBackendProfileRecord = typeof RemoteBackendProfileRecord.Type;

export class RemoteBackendProfileConflict extends Schema.TaggedErrorClass<RemoteBackendProfileConflict>()(
  "RemoteBackendProfileConflict",
  { detail: Schema.String },
) {}

export type RemoteBackendProfileError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | RemoteBackendProfileConflict;

export interface RemoteBackendProfilesShape {
  readonly list: () => Effect.Effect<
    ReadonlyArray<RemoteBackendProfileRecord>,
    RemoteBackendProfileError
  >;
  readonly get: (
    profileId: string,
  ) => Effect.Effect<RemoteBackendProfileRecord | undefined, RemoteBackendProfileError>;
  readonly findByRequestId: (
    requestId: string,
  ) => Effect.Effect<RemoteBackendProfileRecord | undefined, RemoteBackendProfileError>;
  readonly findByTarget: (
    executionTargetId: string,
  ) => Effect.Effect<RemoteBackendProfileRecord | undefined, RemoteBackendProfileError>;
  /** Insert once. Identical replay returns the stored row; any other collision conflicts. */
  readonly insert: (
    record: RemoteBackendProfileRecord,
  ) => Effect.Effect<RemoteBackendProfileRecord, RemoteBackendProfileError>;
}

export class RemoteBackendProfiles extends ServiceMap.Service<
  RemoteBackendProfiles,
  RemoteBackendProfilesShape
>()("bigbud/persistence/RemoteBackendProfiles") {}
