import * as Schema from "effect/Schema";
import {
  RemoteBackendAuthority,
  RemoteBackendInstallationFingerprint,
} from "./remoteBackendHandshake";

export const RemoteBackendRelayProfileId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
);
export const RemoteBackendRelayLeaseId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
);
export const RemoteBackendRelayProfile = Schema.Struct({
  profileId: RemoteBackendRelayProfileId,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  identity: Schema.Struct({
    authority: RemoteBackendAuthority,
    installationFingerprint: RemoteBackendInstallationFingerprint,
  }),
});
export type RemoteBackendRelayProfile = typeof RemoteBackendRelayProfile.Type;
export const RemoteBackendRelayListResult = Schema.Struct({
  availability: Schema.Literals(["available", "setup-required"]),
  profiles: Schema.Array(RemoteBackendRelayProfile).check(Schema.isMaxLength(64)),
});
export type RemoteBackendRelayListResult = typeof RemoteBackendRelayListResult.Type;
export const RemoteBackendRelayOpenInput = Schema.Struct({
  profileId: RemoteBackendRelayProfileId,
  requestId: RemoteBackendRelayLeaseId,
});
export type RemoteBackendRelayOpenInput = typeof RemoteBackendRelayOpenInput.Type;
export const RemoteBackendRelayLease = Schema.Struct({
  leaseId: RemoteBackendRelayLeaseId,
  profileId: RemoteBackendRelayProfileId,
  baseUrl: Schema.String.check(Schema.isPattern(/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/)),
  localCredential: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type RemoteBackendRelayLease = typeof RemoteBackendRelayLease.Type;
export const RemoteBackendRelayCloseInput = Schema.Union([
  Schema.Struct({ leaseId: RemoteBackendRelayLeaseId }),
  Schema.Struct({ requestId: RemoteBackendRelayLeaseId }),
]);
export type RemoteBackendRelayCloseInput = typeof RemoteBackendRelayCloseInput.Type;
export const RemoteBackendRelayCloseResult = Schema.Struct({ closed: Schema.Boolean });
export class RemoteBackendRelayError extends Schema.TaggedErrorClass<RemoteBackendRelayError>()(
  "RemoteBackendRelayError",
  {
    code: Schema.Literals([
      "setup-required",
      "unavailable",
      "caller-closed",
      "limit",
      "not-found",
      "conflict",
    ]),
    message: Schema.String,
  },
) {}

export interface RemoteBackendRelayNativeApi {
  readonly listRemoteBackendRelayProfiles: () => Promise<RemoteBackendRelayListResult>;
  readonly openRemoteBackendRelay: (
    input: RemoteBackendRelayOpenInput,
  ) => Promise<RemoteBackendRelayLease>;
  readonly closeRemoteBackendRelay: (
    input: RemoteBackendRelayCloseInput,
  ) => Promise<typeof RemoteBackendRelayCloseResult.Type>;
}
