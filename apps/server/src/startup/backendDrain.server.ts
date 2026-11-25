import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { unixSocketPathMaxBytes } from "@bigbud/shared/privateSocketPath";

import {
  BACKEND_DRAIN_ADMISSION_MS,
  BACKEND_DRAIN_MAX_REQUEST_BYTES,
  parseBackendDrainRequest,
  type BackendDrainResponse,
} from "./backendDrain.protocol.ts";

export function backendDrainControlPaths(stateDir: string) {
  const directory = join(stateDir, "control");
  return {
    directory,
    socketPath: join(directory, "backend-drain.sock"),
    tokenPath: join(directory, "backend-drain.token"),
  };
}

export class BackendDrainControlUnavailableError extends Error {
  readonly _tag = "BackendDrainControlUnavailableError";
}

const failure = (
  code: "invalid-request" | "unauthorized" | "unavailable" | "failed",
  message: string,
): BackendDrainResponse => ({ v: 1, ok: false, error: { code, message } });

const tokenMatches = (expected: string, actual: string) => {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
};

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new BackendDrainControlUnavailableError(`${directory} must be a real directory.`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new BackendDrainControlUnavailableError(`${directory} is not owned by this account.`);
  if ((info.mode & 0o077) !== 0) await chmod(directory, 0o700);
}

/** Starts the owner-only socket and returns its token path for the same-user CLI. */
export async function startBackendDrainControlServer(input: {
  readonly stateDir: string;
  readonly token: string;
  readonly handle: (
    request: import("./backendDrain.protocol.ts").BackendDrainRequest,
  ) => Promise<BackendDrainResponse>;
}): Promise<{ readonly close: () => Promise<void> }> {
  if (process.platform === "win32")
    throw new BackendDrainControlUnavailableError(
      "The backend drain control socket is not available on Windows yet.",
    );
  const { directory, socketPath, tokenPath } = backendDrainControlPaths(input.stateDir);
  if (Buffer.byteLength(socketPath) > unixSocketPathMaxBytes())
    throw new BackendDrainControlUnavailableError(
      "The bigbud state directory path is too long for the drain control socket.",
    );
  await privateDirectory(directory);
  const previous = await lstat(socketPath).catch(() => null);
  if (previous && !previous.isSocket())
    throw new BackendDrainControlUnavailableError(`${socketPath} exists and is not a socket.`);
  if (previous) await unlink(socketPath);
  await writeFile(tokenPath, `${input.token}\n`, { mode: 0o600 });
  await chmod(tokenPath, 0o600);

  const clients = new Set<Socket>();
  const server: Server = createServer((socket) => {
    const lifetime = setTimeout(() => socket.destroy(), BACKEND_DRAIN_ADMISSION_MS + 5_000);
    socket.on("close", () => clearTimeout(lifetime));
    socket.on("error", () => socket.destroy());
    const reply = (response: BackendDrainResponse) => {
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
    };
    if (clients.size >= 4) {
      reply(failure("unavailable", "Too many concurrent drain requests."));
      return;
    }
    clients.add(socket);
    let buffered = Buffer.alloc(0);
    let handled = false;
    const deadline = setTimeout(() => {
      if (handled) return;
      handled = true;
      reply(failure("invalid-request", "Request was not received in time."));
    }, BACKEND_DRAIN_ADMISSION_MS);
    socket.on("close", () => {
      clearTimeout(deadline);
      clients.delete(socket);
    });
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0 && buffered.length <= BACKEND_DRAIN_MAX_REQUEST_BYTES) return;
      handled = true;
      clearTimeout(deadline);
      if (newline < 0 || newline > BACKEND_DRAIN_MAX_REQUEST_BYTES) {
        reply(failure("invalid-request", "Request exceeds 8 KiB."));
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
      } catch {
        reply(failure("invalid-request", "Request is not valid JSON."));
        return;
      }
      const parsed = parseBackendDrainRequest(raw);
      if ("error" in parsed) {
        reply(failure("invalid-request", parsed.error));
        return;
      }
      if (!tokenMatches(input.token, parsed.token)) {
        reply(failure("unauthorized", "Request is not authorized."));
        return;
      }
      input
        .handle(parsed)
        .then(reply, (cause: unknown) =>
          reply(failure("failed", cause instanceof Error ? cause.message : "Drain failed.")),
        );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return {
    close: async () => {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
      await unlink(tokenPath).catch(() => undefined);
    },
  };
}

/** Same-user client. The token file must be mode 0600 and owned by this account. */
export async function readBackendDrainToken(stateDir: string): Promise<string> {
  const { tokenPath } = backendDrainControlPaths(stateDir);
  const info = await lstat(tokenPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new BackendDrainControlUnavailableError(
      "The backend drain token is not private to this account.",
    );
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new BackendDrainControlUnavailableError("The backend drain token is malformed.");
  return token;
}
