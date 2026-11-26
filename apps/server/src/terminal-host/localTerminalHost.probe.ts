import * as fs from "node:fs/promises";
import { createConnection } from "node:net";

import type { RemoteAgentConnection } from "../remote-agent/remoteAgentConnection.ts";
import { assertPrivateDirectory } from "./localTerminalHost.fs.ts";
import type { LocalTerminalHostGenerationPaths } from "./localTerminalHost.paths.ts";
import {
  connectLocalTerminalHostProxy,
  type LocalTerminalHostConnect,
  type LocalTerminalHostHello,
} from "./localTerminalHost.transport.ts";

const PROBE_TIMEOUT_MS = 3_000;

export class LocalTerminalHostSocketError extends Error {
  readonly _tag = "LocalTerminalHostSocketError";
}

/** The existing secure-socket rule: an owned, non-symlink socket with no group/other bits. */
export async function assertSecureLocalTerminalHostSocket(socketPath: string): Promise<void> {
  const stat = await fs.lstat(socketPath);
  const uid = process.getuid?.();
  if (
    stat.isSymbolicLink() ||
    !stat.isSocket() ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o077) !== 0
  )
    throw new LocalTerminalHostSocketError(`Insecure terminal host socket: ${socketPath}`);
  await assertPrivateDirectory(socketPath.slice(0, socketPath.lastIndexOf("/")));
}

/**
 * - `hello`: reachable on protocol major 1; compatibility is decided from this alone.
 * - `gone`: no socket or nothing listening; there is no process to keep or stop.
 * - `incompatible`: a listener that speaks another protocol major.
 * - `unreachable`: a listener that did not complete the handshake.
 * - `insecure`: a socket this backend must never dial or act on.
 */
export type LocalTerminalHostProbe =
  | { readonly kind: "hello"; readonly hello: LocalTerminalHostHello }
  | { readonly kind: "gone" }
  | { readonly kind: "incompatible"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string }
  | { readonly kind: "insecure"; readonly reason: string };

/** A Unix socket refusing a connection has no listener; anything else is a live endpoint. */
export function localSocketListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code !== "ECONNREFUSED" && error.code !== "ENOENT");
    });
  });
}

function isMajorMismatch(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return (
    (typeof code === "string" && code.includes("PROTOCOL_MAJOR")) || /protocol major/i.test(message)
  );
}

async function withTimeout<A>(operation: Promise<A>, timeoutMs: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Terminal host probe timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ProbeLocalTerminalHostInput {
  readonly generation: LocalTerminalHostGenerationPaths;
  readonly proxyBinary: string;
  readonly connect?: LocalTerminalHostConnect;
  readonly assertSocket?: (socketPath: string) => Promise<void>;
  readonly listening?: (socketPath: string) => Promise<boolean>;
  readonly timeoutMs?: number;
}

/** One short-lived proxy handshake. Closing it ends only the proxy, never the host. */
export async function probeLocalTerminalHost(
  input: ProbeLocalTerminalHostInput,
): Promise<LocalTerminalHostProbe> {
  try {
    await fs.lstat(input.generation.socketPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { kind: "gone" };
    return { kind: "insecure", reason: String(cause) };
  }
  try {
    await (input.assertSocket ?? assertSecureLocalTerminalHostSocket)(input.generation.socketPath);
  } catch (cause) {
    return { kind: "insecure", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  let connection: RemoteAgentConnection | undefined;
  try {
    connection = connectLocalTerminalHostProxy(
      input.proxyBinary,
      input.generation.statePath,
      input.connect,
    );
    const hello = await withTimeout(connection.handshake(), input.timeoutMs ?? PROBE_TIMEOUT_MS);
    return { kind: "hello", hello };
  } catch (cause) {
    if (isMajorMismatch(cause))
      return {
        kind: "incompatible",
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    const listening = await (input.listening ?? localSocketListening)(input.generation.socketPath);
    if (!listening) return { kind: "gone" };
    return { kind: "unreachable", reason: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    connection?.close();
  }
}
