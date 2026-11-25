import { GRAPH_STAGE_SCRIPT } from "./deployment.fetch.ts";
import {
  deploymentError,
  DEPLOYMENT_REQUEST_ID,
  type DeploymentRemoteCommand,
} from "./deployment.types.ts";

export const MAX_PROOF_MANIFEST_BYTES = 48 * 1024;

export interface DeploymentManifestRequest {
  readonly executionTargetId: string;
  readonly action: {
    readonly kind: "putGraphManifest";
    readonly requestId: string;
    readonly manifestSha256: string;
    readonly contents: Uint8Array;
  };
}

/** Only the exact manifest text call. Archive/file input and other recipe stages are not admitted. */
export function matchGraphManifestPut(
  command: DeploymentRemoteCommand,
): DeploymentManifestRequest["action"] | undefined {
  const [flag, script, argv0, op, requestId, name, manifestSha256] = command.args;
  if (
    command.command !== "/bin/sh" ||
    command.args.length !== 7 ||
    flag !== "-c" ||
    script !== GRAPH_STAGE_SCRIPT ||
    argv0 !== "sh" ||
    op !== "put" ||
    name !== "manifest.json" ||
    command.env !== undefined ||
    command.timeoutMs !== 60_000
  )
    return undefined;
  const input = command.stdin;
  if (
    !requestId ||
    !DEPLOYMENT_REQUEST_ID.test(requestId) ||
    !manifestSha256 ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    !input ||
    !("text" in input) ||
    typeof input.text !== "string" ||
    !input.text ||
    Buffer.byteLength(input.text) > MAX_PROOF_MANIFEST_BYTES
  ) {
    throw deploymentError("invalid-target", "Invalid bounded deployment manifest input.");
  }
  return {
    kind: "putGraphManifest",
    requestId,
    manifestSha256,
    contents: new TextEncoder().encode(input.text),
  };
}
