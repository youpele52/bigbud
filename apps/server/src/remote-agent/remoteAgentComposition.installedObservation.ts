import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { assertRemoteAgentRuntimeHello } from "./remoteAgentCompatibility.ts";
import type { VerifiedInstalledProxyObservation } from "./remoteAgentComposition.installedAdmission.ts";
import { decodeDelimitedFrame, encodeDelimitedFrame } from "./remoteAgentProtocol.codec.ts";
import {
  REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
  REMOTE_AGENT_PROTOCOL_MAJOR,
  REMOTE_AGENT_PROTOCOL_MINOR,
} from "./remoteAgentProtocol.ts";
import { validateRemoteAgentRuntime, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

export type InstalledObservationRefusal = "observation-required" | "identity-mismatch";

/** Typed observation failure; both reasons are composition refusals, never retries. */
export class InstalledObservationError extends Error {
  readonly _tag = "InstalledObservationError";

  constructor(
    readonly reason: InstalledObservationRefusal,
    message: string,
  ) {
    super(message);
    this.name = "InstalledObservationError";
  }
}

/**
 * Only for an endpoint already bound by a trusted caller to this local socket
 * namespace (e.g. the isolated Linux proof). Target IDs and registry paths do
 * not establish that mapping. This does not resolve or dial a remote target.
 */
export async function observeLocalInstalledSupervisor(input: {
  readonly executionTargetId: string;
  readonly runtime: RemoteAgentRuntime;
  readonly expectedEpoch: string;
}): Promise<VerifiedInstalledProxyObservation> {
  const { executionTargetId, expectedEpoch } = input;
  const runtime = validateRemoteAgentRuntime(input.runtime);
  if (!executionTargetId || !expectedEpoch || runtime.origin !== "managed") {
    throw new InstalledObservationError(
      "observation-required",
      "Installed supervisor observation requires a pinned local endpoint.",
    );
  }
  const socket = createConnection(runtime.socketPath);
  try {
    const hello = await exchangeHello(socket);
    try {
      assertRemoteAgentRuntimeHello(runtime, hello);
    } catch (cause) {
      throw new InstalledObservationError("identity-mismatch", errorMessage(cause));
    }
    if (hello.agentEpoch !== expectedEpoch) {
      throw new InstalledObservationError(
        "identity-mismatch",
        "Installed supervisor epoch differs from its pinned identity.",
      );
    }
    return Object.freeze({
      executionTargetId,
      runtime,
      supervisorEpoch: hello.agentEpoch,
      agentInstanceId: hello.agentInstanceId,
    });
  } catch (cause) {
    if (cause instanceof InstalledObservationError) throw cause;
    throw new InstalledObservationError("observation-required", errorMessage(cause));
  } finally {
    socket.destroy();
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function exchangeHello(socket: Socket) {
  const timeout = setTimeout(
    () => socket.destroy(new Error("Timed out waiting for agent hello")),
    5_000,
  );
  try {
    socket.write(
      encodeDelimitedFrame({
        type: "clientHello",
        value: {
          protocolMajor: REMOTE_AGENT_PROTOCOL_MAJOR,
          protocolMinor: REMOTE_AGENT_PROTOCOL_MINOR,
          clientInstanceId: randomUUID(),
          connectionId: randomUUID(),
          serverNonce: randomUUID(),
          maxFrameBytes: REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES,
        },
      }),
    );
    const header = Buffer.allocUnsafe(4);
    let bytes: Buffer | undefined;
    let received = 0;
    for await (const chunk of socket.iterator({
      destroyOnReturn: false,
    }) as AsyncIterable<Buffer>) {
      let offset = 0;
      if (!bytes) {
        offset = chunk.copy(header, received, 0, 4 - received);
        received += offset;
        if (received < 4) continue;
        const length = header.readUInt32BE(0);
        if (length > REMOTE_AGENT_DEFAULT_MAX_FRAME_BYTES) throw new Error("Oversized agent hello");
        bytes = Buffer.allocUnsafe(length + 4);
        header.copy(bytes);
      }
      received += chunk.copy(bytes, received, offset);
      if (received < bytes.length) continue;
      const hello = decodeDelimitedFrame(bytes);
      if (hello.type !== "agentHello") {
        throw new InstalledObservationError(
          "identity-mismatch",
          `Expected agent hello, got ${hello.type}`,
        );
      }
      return hello.value;
    }
    throw new Error("Agent stream reached EOF before hello");
  } finally {
    clearTimeout(timeout);
  }
}
