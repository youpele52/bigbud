import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import type {
  RemoteAgentProxyLease,
  RemoteAgentProxyOwner,
} from "./remoteAgentConnection.owner.ts";
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
  const runtime = pinned(input);
  const socket = createConnection(runtime.socketPath);
  try {
    return await observe(input, runtime, socket, socket, (error) => socket.destroy(error));
  } finally {
    socket.destroy();
  }
}

/**
 * U25 production observation: the same pinned hello, carried by one owner proxy lease for the
 * exact runtime (the owner re-verifies the binary before `--proxy` runs). The lease is closed
 * afterwards; nothing here launches, prepares or restarts a supervisor.
 */
export async function observeOwnedInstalledSupervisor(input: {
  readonly executionTargetId: string;
  readonly runtime: RemoteAgentRuntime;
  readonly expectedEpoch: string;
  readonly owner: RemoteAgentProxyOwner;
}): Promise<VerifiedInstalledProxyObservation> {
  const runtime = pinned(input);
  let lease: RemoteAgentProxyLease;
  try {
    lease = await input.owner.openAgentProxy({
      executionTargetId: input.executionTargetId,
      runtime,
    });
  } catch (cause) {
    throw new InstalledObservationError("observation-required", errorMessage(cause));
  }
  try {
    return await observe(input, runtime, lease.pipes.stdin, lease.pipes.stdout, (error) =>
      lease.pipes.stdout.destroy(error),
    );
  } finally {
    await lease.close({ mode: "terminate", timeoutMs: 5_000 }).catch(() => undefined);
  }
}

function pinned(input: {
  readonly executionTargetId: string;
  readonly runtime: RemoteAgentRuntime;
  readonly expectedEpoch: string;
}): RemoteAgentRuntime {
  const runtime = validateRemoteAgentRuntime(input.runtime);
  if (!input.executionTargetId || !input.expectedEpoch || runtime.origin !== "managed") {
    throw new InstalledObservationError(
      "observation-required",
      "Installed supervisor observation requires a pinned endpoint.",
    );
  }
  return runtime;
}

async function observe(
  input: { readonly executionTargetId: string; readonly expectedEpoch: string },
  runtime: RemoteAgentRuntime,
  writable: Writable,
  readable: Readable,
  abort: (error: Error) => void,
): Promise<VerifiedInstalledProxyObservation> {
  const { executionTargetId, expectedEpoch } = input;
  try {
    const hello = await exchangeHello(writable, readable, abort);
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
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function exchangeHello(
  writable: Writable,
  readable: Readable,
  abort: (error: Error) => void,
) {
  const timeout = setTimeout(() => abort(new Error("Timed out waiting for agent hello")), 5_000);
  try {
    writable.write(
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
    for await (const chunk of readable.iterator({
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
