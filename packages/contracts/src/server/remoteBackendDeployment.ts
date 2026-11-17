import * as Schema from "effect/Schema";
import { RemoteBackendAuthority } from "./remoteBackendHandshake";
import { RemoteBackendRelayProfileId } from "./remoteBackendRelay";

/** Caller nonce: a repeated request with the same id joins or returns the same deployment. */
export const RemoteBackendDeploymentRequestId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
);
export const RemoteBackendDeploymentInput = Schema.Struct({
  /** A saved or D5-approved SSH remote-agent execution target. Never a host, path or command. */
  executionTargetId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  requestId: RemoteBackendDeploymentRequestId,
  /** true: enable boot startup (D8 consent). false: start for this session only. */
  enableBoot: Schema.Boolean,
});
export type RemoteBackendDeploymentInput = typeof RemoteBackendDeploymentInput.Type;

export const RemoteBackendDeploymentStatus = Schema.Literals(["started", "enabled"]);
export type RemoteBackendDeploymentStatus = typeof RemoteBackendDeploymentStatus.Type;

export const RemoteBackendDeploymentResult = Schema.Struct({
  profileId: RemoteBackendRelayProfileId,
  authority: RemoteBackendAuthority,
  status: RemoteBackendDeploymentStatus,
});
export type RemoteBackendDeploymentResult = typeof RemoteBackendDeploymentResult.Type;

export class RemoteBackendDeploymentError extends Schema.TaggedErrorClass<RemoteBackendDeploymentError>()(
  "RemoteBackendDeploymentError",
  {
    code: Schema.Literals([
      "approval-required",
      "invalid-target",
      "unsupported-host",
      "host-changed",
      "conflict",
      "busy",
      "graph-unavailable",
      "hash-mismatch",
      "setup-failed",
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}
