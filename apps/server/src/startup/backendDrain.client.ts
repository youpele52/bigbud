import { createConnection } from "node:net";

import {
  BACKEND_DRAIN_MAX_REQUEST_BYTES,
  BACKEND_DRAIN_MAX_WAIT_MS,
  BACKEND_DRAIN_VERSION,
  parseBackendDrainRequest,
  type BackendDrainConsent,
  type BackendDrainResponse,
} from "./backendDrain.protocol.ts";
import {
  BackendDrainControlUnavailableError,
  backendDrainControlPaths,
  readBackendDrainToken,
} from "./backendDrain.server.ts";

export interface BackendDrainClientInput {
  readonly stateDir: string;
  readonly artifactId: string;
  readonly consent: BackendDrainConsent;
  readonly waitMs?: number;
}

/** One bounded request to the same-user backend control socket. */
export async function requestBackendDrain(
  input: BackendDrainClientInput,
): Promise<BackendDrainResponse> {
  const { socketPath } = backendDrainControlPaths(input.stateDir);
  const token = await readBackendDrainToken(input.stateDir);
  const request = parseBackendDrainRequest({
    v: BACKEND_DRAIN_VERSION,
    token,
    method: "drain",
    artifactId: input.artifactId,
    consent: input.consent,
    waitMs: Math.min(input.waitMs ?? BACKEND_DRAIN_MAX_WAIT_MS, BACKEND_DRAIN_MAX_WAIT_MS),
  });
  if ("error" in request)
    throw new BackendDrainControlUnavailableError("The drain request is invalid.");
  const socket = createConnection(socketPath);
  const timeout = setTimeout(
    () => socket.destroy(new Error("backend_drain_timeout")),
    Math.min(BACKEND_DRAIN_MAX_WAIT_MS, request.waitMs) + 5_000,
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
    const response = JSON.parse(raw) as BackendDrainResponse;
    if (response?.v !== BACKEND_DRAIN_VERSION)
      throw new Error("The backend drain response has the wrong version.");
    return response;
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}
