import { lstat, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

/**
 * Same-user client for the backend drain control socket (W3.4). Shared by the
 * server CLI (`backend stop --for-upgrade`) and the desktop updater so both
 * upgrade entries reach the same authenticated endpoint. The server owns
 * request validation and the typed response; this module owns only the paths,
 * the private token and one bounded newline-delimited exchange.
 *
 * @module backendDrain.client
 */
export const BACKEND_DRAIN_VERSION = 1;
export const BACKEND_DRAIN_MAX_REQUEST_BYTES = 8 * 1024;
export const BACKEND_DRAIN_MAX_WAIT_MS = 25_000;

export type BackendDrainConsent = "non-interactive" | "ui";

export interface BackendDrainClientInput {
  readonly stateDir: string;
  readonly artifactId: string;
  readonly consent: BackendDrainConsent;
  readonly waitMs?: number;
}

/** Wire shape only; the server narrows `status` and `error.code`. */
export type BackendDrainWireResponse =
  | { readonly v: 1; readonly ok: true; readonly status: string; readonly stops?: unknown }
  | {
      readonly v: 1;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export class BackendDrainControlUnavailableError extends Error {
  readonly _tag = "BackendDrainControlUnavailableError";
}

export function backendDrainControlPaths(stateDir: string) {
  const directory = join(stateDir, "control");
  return {
    directory,
    socketPath: join(directory, "backend-drain.sock"),
    tokenPath: join(directory, "backend-drain.token"),
  };
}

const TOKEN = /^[a-f0-9]{64}$/;

/** The token file must be mode 0600 and owned by this account. */
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
  if (!TOKEN.test(token))
    throw new BackendDrainControlUnavailableError("The backend drain token is malformed.");
  return token;
}

/** One bounded request to the same-user backend control socket. */
export async function requestBackendDrainControl(
  input: BackendDrainClientInput,
): Promise<BackendDrainWireResponse> {
  const { socketPath } = backendDrainControlPaths(input.stateDir);
  const token = await readBackendDrainToken(input.stateDir);
  const waitMs = Math.min(input.waitMs ?? BACKEND_DRAIN_MAX_WAIT_MS, BACKEND_DRAIN_MAX_WAIT_MS);
  if (
    input.artifactId.length === 0 ||
    input.artifactId.length > 256 ||
    !Number.isInteger(waitMs) ||
    waitMs < 0
  )
    throw new BackendDrainControlUnavailableError("The drain request is invalid.");
  const request = {
    v: BACKEND_DRAIN_VERSION,
    token,
    method: "drain",
    artifactId: input.artifactId,
    consent: input.consent,
    waitMs,
  };
  const socket = createConnection(socketPath);
  const timeout = setTimeout(
    () => socket.destroy(new Error("backend_drain_timeout")),
    waitMs + 5_000,
  );
  let buffered = Buffer.alloc(0);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify(request)}\n`);
    const raw = await new Promise<string>((resolve, reject) => {
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > BACKEND_DRAIN_MAX_REQUEST_BYTES) {
          reject(new Error("backend_drain_response_too_large"));
          return;
        }
        const newline = buffered.indexOf(0x0a);
        if (newline >= 0) resolve(buffered.subarray(0, newline).toString("utf8"));
      });
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("backend_drain_connection_closed")));
    });
    const response = JSON.parse(raw) as BackendDrainWireResponse;
    if (response?.v !== BACKEND_DRAIN_VERSION)
      throw new Error("The backend drain response has the wrong version.");
    return response;
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}
