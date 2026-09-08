import { RemoteAgentConnection, RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";
import { assertRemoteAgentRuntimeHello } from "./remoteAgentCompatibility.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { RemoteAgentAdmissionError } from "./remoteAgentAdmission.types.ts";

const REQUIRED_CAPABILITIES = [
  "diagnostic",
  "workspace.files",
  "workspace.search",
  "workspace.write",
  "workspace.watch",
  "process.run",
  "process.attach",
  "terminal.pty",
] as const;

/**
 * Verify a pinned runtime without opening a workspace, process, or terminal
 * resource. The readiness diagnostic is deliberately the only post-hello
 * request made by this path.
 */
export async function verifyRemoteAgentRuntimeHealth(input: {
  readonly target: string;
  readonly runtime: RemoteAgentRuntime;
  readonly expectedEpoch?: string;
  readonly connect: (target: string, runtime: RemoteAgentRuntime) => RemoteAgentConnection;
}): Promise<string> {
  const connection = input.connect(input.target, input.runtime);
  const timer = setTimeout(() => connection.close(), 30_000);
  try {
    const hello = await connection.handshake().catch((cause: unknown) => {
      if (
        cause instanceof RemoteAgentConnectionError &&
        cause.code === "UNSUPPORTED_PROTOCOL_MAJOR"
      ) {
        throw new RemoteAgentAdmissionError(
          "INCOMPATIBLE_PROTOCOL",
          "Candidate protocol is incompatible.",
          true,
        );
      }
      throw cause;
    });
    try {
      assertRemoteAgentRuntimeHello(input.runtime, hello);
    } catch (cause) {
      throw new RemoteAgentAdmissionError(
        cause instanceof RemoteAgentConnectionError
          ? (cause.code ?? "INVALID_HELLO")
          : "INVALID_HELLO",
        "Remote runtime identity or limits are invalid.",
        true,
      );
    }
    if (input.expectedEpoch && input.expectedEpoch !== hello.agentEpoch) {
      throw new RemoteAgentAdmissionError(
        "IDENTITY_MISMATCH",
        "Remote runtime continuity or identity does not match.",
        true,
      );
    }
    for (const name of REQUIRED_CAPABILITIES) {
      if (
        !hello.capabilities.some((capability) => capability.name === name && capability.major === 1)
      ) {
        throw new RemoteAgentAdmissionError(
          "INCOMPATIBLE_CAPABILITY",
          "Remote runtime lacks a required capability.",
          true,
        );
      }
    }
    const id = `readiness-${crypto.randomUUID()}`;
    const response = await connection.request(
      {
        type: "diagnosticRequest",
        value: {
          requestId: id,
          operationId: id,
          requestDigest: remoteAgentRequestDigest(id),
          workspaceHandle: "",
          deadlineUnixMs: Date.now() + 30_000,
          kind: "readiness",
        },
      },
      (frame) => frame.type === "diagnosticResponse" && frame.value.requestId === id,
    );
    if (
      response.type !== "diagnosticResponse" ||
      !response.value.accepted ||
      !response.value.terminal ||
      response.value.message !== "agent-ready"
    ) {
      throw new RemoteAgentAdmissionError(
        "NOT_READY",
        "Remote runtime did not confirm readiness.",
        true,
      );
    }
    return hello.agentEpoch;
  } finally {
    clearTimeout(timer);
    connection.close();
  }
}
