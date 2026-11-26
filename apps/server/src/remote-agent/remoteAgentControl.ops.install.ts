import type { RemoteAgentArtifact, RemoteAgentTargetTriple } from "./remoteAgentArtifact.ts";
import { buildRemoteAgentIdentityProbeCommand } from "./remoteAgentConnection.identity.ts";
import { REMOTE_AGENT_DEFAULT_BINARY } from "./remoteAgentControl.ops.ts";
import {
  buildRemoteAgentInboxAdoptionScript,
  buildRemoteAgentPlacedProbeScript,
} from "./remoteAgentInstall.inbox.ts";
import {
  buildRemoteAgentInstallPaths,
  buildRemoteAgentInstallScript,
} from "./remoteAgentInstall.ts";
import { buildRemoteAgentPlatformProbeScript } from "./remoteAgentPlatform.ts";
import { buildRemoteAgentRegistryReadOnlyProbe } from "./remoteAgentReadOnlyStatus.ts";

/**
 * U25 install-side operations. The legacy install manager runs these through its
 * own SSH dependencies (with stdin for the upload); the production manager runs
 * each as one owner `agent_control` kind. Only `installUpload` carries bytes, and
 * those travel on the lease socket, never in a frame or on a command line.
 */
export interface RemoteAgentArtifactIdentity {
  readonly version: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly targetTriple: RemoteAgentTargetTriple;
}

export type RemoteAgentInstallControlOp =
  | { readonly kind: "platformProbe" }
  | { readonly kind: "readOnlyStatus" }
  | {
      readonly kind: "installUpload";
      readonly artifact: RemoteAgentArtifactIdentity;
      readonly reservationId: string | null;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: "placedProbe"; readonly artifact: RemoteAgentArtifactIdentity }
  | {
      readonly kind: "inboxAdopt";
      readonly artifact: RemoteAgentArtifactIdentity;
      readonly reservationId: string | null;
    }
  | {
      readonly kind: "identityCheck";
      readonly artifact: Pick<RemoteAgentArtifactIdentity, "version" | "sha256">;
    }
  /** `--check` of a configured binary; `null` is the legacy default selector. */
  | { readonly kind: "binaryCheck"; readonly binaryPath: string | null };

/** The identity fields of a signed artifact, in the shape the builders read. */
export function remoteAgentArtifactIdentity(
  artifact: Pick<RemoteAgentArtifact, "version" | "sha256" | "sizeBytes" | "targetTriple">,
): RemoteAgentArtifactIdentity {
  return {
    version: artifact.version,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    targetTriple: artifact.targetTriple,
  };
}

const asArtifact = (identity: RemoteAgentArtifactIdentity) =>
  identity as unknown as RemoteAgentArtifact;

/**
 * The legacy script for one install-side operation. The upload's legacy stdin is the
 * base64 of its bytes; the owner template reads raw bytes instead (see the generator).
 */
export function compileRemoteAgentInstallControlOp(op: RemoteAgentInstallControlOp): string {
  switch (op.kind) {
    case "platformProbe":
      return buildRemoteAgentPlatformProbeScript();
    case "readOnlyStatus":
      return buildRemoteAgentRegistryReadOnlyProbe();
    case "installUpload":
      return buildRemoteAgentInstallScript({
        artifact: asArtifact(op.artifact),
        targetTriple: op.artifact.targetTriple,
        stagedBase64: Buffer.from(op.bytes).toString("base64") || "-",
        ...(op.reservationId === null ? {} : { reservationId: op.reservationId }),
      }).command;
    case "placedProbe":
      return buildRemoteAgentPlacedProbeScript(op.artifact);
    case "inboxAdopt":
      return buildRemoteAgentInboxAdoptionScript({
        artifact: asArtifact(op.artifact),
        targetTriple: op.artifact.targetTriple,
        ...(op.reservationId === null ? {} : { reservationId: op.reservationId }),
      }).command;
    case "binaryCheck":
      return buildRemoteAgentIdentityProbeCommand(op.binaryPath ?? REMOTE_AGENT_DEFAULT_BINARY);
    case "identityCheck":
      return buildRemoteAgentIdentityProbeCommand(
        buildRemoteAgentInstallPaths(op.artifact).installedBinary,
      );
  }
}
