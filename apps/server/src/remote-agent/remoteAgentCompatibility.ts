import { RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import type { RemoteAgentHello } from "./remoteAgentProtocol.ts";

// Recognizes the legacy version-reporting defect, not artifact authenticity.
const LEGACY_VERSION_ALIAS_DIGEST = "461b7865cd28bb2570d9f580405fa53daee7b51f";

/** Every recovery transport must match the pinned identity; the sole legacy version alias is 205/0.1.0. */
export function assertRemoteAgentRuntimeHello(
  runtime: RemoteAgentRuntime,
  hello: RemoteAgentHello,
): void {
  const architecture = runtime.targetTriple.startsWith("aarch64") ? "aarch64" : "x86_64";
  const versionMatches =
    hello.agentVersion === runtime.version ||
    (runtime.version === "0.2.205" &&
      runtime.buildDigest === LEGACY_VERSION_ALIAS_DIGEST &&
      hello.agentVersion === "0.1.0");
  if (
    !versionMatches ||
    hello.buildDigest !== runtime.buildDigest ||
    hello.os !== "linux" ||
    hello.architecture !== architecture ||
    !hello.agentEpoch ||
    !hello.agentInstanceId
  ) {
    throw new RemoteAgentConnectionError(
      "Remote runtime identity differs from its immutable binding.",
      "IDENTITY_MISMATCH",
    );
  }
  if (hello.protocolMajor !== 1)
    throw new RemoteAgentConnectionError(
      "Remote runtime protocol is incompatible.",
      "UNSUPPORTED_PROTOCOL_MAJOR",
    );
  if (
    ![hello.maxFrameBytes, hello.maxJournalBytes, hello.maxOperationOutputBytes].every(
      (limit) => Number.isSafeInteger(limit) && limit > 0,
    )
  ) {
    throw new RemoteAgentConnectionError("Remote runtime limits are invalid.", "INVALID_LIMITS");
  }
}
