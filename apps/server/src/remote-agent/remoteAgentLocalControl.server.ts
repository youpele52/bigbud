import { startWindowsControlServer } from "./remoteAgentLocalControl.windows.ts";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import {
  createRemoteAgentControlEndpoint,
  defaultRemoteAgentControlTransport,
  removeRemoteAgentControlEndpoint,
  remoteAgentControlTokenMatches,
  writeRemoteAgentControlEndpoint,
  type RemoteAgentControlTransport,
} from "./remoteAgentLocalControl.endpoint.ts";
import {
  parseRemoteAgentControlRequest,
  REMOTE_AGENT_CONTROL_ADMISSION_MS,
  REMOTE_AGENT_CONTROL_MAX_CLIENTS,
  REMOTE_AGENT_CONTROL_MAX_WAIT_MS,
  REMOTE_AGENT_CONTROL_MAX_REQUEST_BYTES,
  REMOTE_AGENT_CONTROL_VERSION,
  type RemoteAgentControlErrorCode,
  type RemoteAgentControlRequest,
  type RemoteAgentControlResponse,
} from "./remoteAgentLocalControl.protocol.ts";

/** Unix socket paths are limited (104 bytes on macOS, 108 on Linux) including the NUL. */
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

export class RemoteAgentLocalControlUnavailableError extends Error {
  readonly _tag = "RemoteAgentLocalControlUnavailableError";
}

function failure(code: RemoteAgentControlErrorCode, message: string): RemoteAgentControlResponse {
  return { v: REMOTE_AGENT_CONTROL_VERSION, ok: false, error: { code, message } };
}

/** Owner-only directory: created 700, refused when it is a link, foreign-owned or widened. */
async function preparePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RemoteAgentLocalControlUnavailableError(`${directory} must be a real directory.`);
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new RemoteAgentLocalControlUnavailableError(`${directory} is not owned by this account.`);
  }
  if ((info.mode & 0o077) !== 0) await chmod(directory, 0o700);
}

async function removeStaleSocket(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (!info.isSocket()) {
    throw new RemoteAgentLocalControlUnavailableError(`${path} exists and is not a socket.`);
  }
  // Only one backend owns the state directory lock, so a leftover socket is stale.
  await unlink(path);
}

/**
 * Serve newline-delimited JSON requests with the D1 bounds: 64 KiB per request, 16 concurrent
 * clients, a 5-second admission deadline, one request per connection. Unix uses an owner-only
 * socket; Windows uses the native account-only pipe bridge; token transport remains a non-Windows test seam.
 */
export async function startRemoteAgentLocalControlServer(input: {
  readonly socketPath: string;
  readonly handle: (request: RemoteAgentControlRequest) => Promise<RemoteAgentControlResponse>;
  readonly transport?: RemoteAgentControlTransport;
  /** Test seam for the named-pipe address. */
  readonly pipeAddress?: (id: string) => string;
}): Promise<{ readonly close: () => Promise<void> }> {
  if (process.platform === "win32") return startWindowsControlServer(input);
  const transport = input.transport ?? defaultRemoteAgentControlTransport();
  const controlDir = dirname(input.socketPath);
  if (
    transport === "unix-socket" &&
    Buffer.byteLength(input.socketPath) > MAX_UNIX_SOCKET_PATH_BYTES
  ) {
    throw new RemoteAgentLocalControlUnavailableError(
      "The bigbud state directory path is too long for a local control socket.",
    );
  }
  await preparePrivateDirectory(controlDir);
  const endpoint =
    transport === "named-pipe" ? createRemoteAgentControlEndpoint(input.pipeAddress) : null;
  if (!endpoint) await removeStaleSocket(input.socketPath);
  const clients = new Set<Socket>();
  const server: Server = createServer((socket) => {
    // 5s admission + 25s operation long-poll + 5s reply-flush allowance.
    // Installs run independently of the socket and return an operation ID for polling.
    // Bound every connection, including rejected peers and handlers that never settle.
    const lifetime = setTimeout(
      () => socket.destroy(),
      REMOTE_AGENT_CONTROL_ADMISSION_MS + REMOTE_AGENT_CONTROL_MAX_WAIT_MS + 5_000,
    );
    socket.on("close", () => clearTimeout(lifetime));
    socket.on("error", () => socket.destroy());
    const reply = (response: RemoteAgentControlResponse) => {
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
    };
    if (clients.size >= REMOTE_AGENT_CONTROL_MAX_CLIENTS) {
      reply(failure("busy", "Too many concurrent requests."));
      return;
    }
    clients.add(socket);
    let buffered = Buffer.alloc(0);
    let handled = false;
    const deadline = setTimeout(() => {
      if (!handled) {
        handled = true;
        reply(failure("invalid-request", "Request was not received in time."));
      }
    }, REMOTE_AGENT_CONTROL_ADMISSION_MS);
    socket.on("close", () => {
      clearTimeout(deadline);
      clients.delete(socket);
    });
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0 && buffered.length <= REMOTE_AGENT_CONTROL_MAX_REQUEST_BYTES) return;
      handled = true;
      clearTimeout(deadline);
      if (newline < 0 || newline > REMOTE_AGENT_CONTROL_MAX_REQUEST_BYTES) {
        reply(failure("invalid-request", "Request exceeds 64 KiB."));
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
      } catch {
        reply(failure("invalid-request", "Request is not valid JSON."));
        return;
      }
      if (
        endpoint &&
        !remoteAgentControlTokenMatches(endpoint.token, (raw as { auth?: unknown } | null)?.auth)
      ) {
        reply(failure("invalid-request", "Request is not authorized."));
        return;
      }
      const parsed = parseRemoteAgentControlRequest(raw);
      if ("error" in parsed) {
        reply(failure(parsed.unsupported ? "unsupported-method" : "invalid-request", parsed.error));
        return;
      }
      input
        .handle(parsed)
        .then(reply, (cause: unknown) =>
          reply(failure("internal", cause instanceof Error ? cause.message : "Request failed.")),
        );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint ? endpoint.address : input.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    if (endpoint) await writeRemoteAgentControlEndpoint(controlDir, endpoint);
    else await chmod(input.socketPath, 0o600);
  } catch (cause) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw cause;
  }
  return {
    close: async () => {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (endpoint) await removeRemoteAgentControlEndpoint(controlDir, endpoint).catch(() => {});
      else await unlink(input.socketPath).catch(() => undefined);
    },
  };
}
