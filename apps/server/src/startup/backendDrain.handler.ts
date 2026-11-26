import type {
  BackendDrainRequest,
  BackendDrainResponse,
  BackendDrainStatus,
} from "./backendDrain.protocol.ts";

/**
 * Process-local handler registry for the authenticated drain socket. The server
 * starts before persistence and the live terminal manager; the layer that owns
 * panes registers the real handler once it exists. An unregistered backend says
 * `unavailable` and never writes a marker.
 *
 * @module backendDrain.handler
 */
export type BackendDrainHandler = (request: BackendDrainRequest) => Promise<BackendDrainResponse>;

let handler: BackendDrainHandler | undefined;
let running = false;

export function registerBackendDrainHandler(next: BackendDrainHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = undefined;
  };
}

export function isBackendDrainRunning(): boolean {
  return running;
}

/** Serializes drains: a concurrent request reports `busy` without touching state. */
export async function handleBackendDrain(
  request: BackendDrainRequest,
): Promise<BackendDrainResponse> {
  const active = handler;
  if (!active)
    return request.consent === "ui"
      ? { v: 1, ok: true, status: "consent-required" }
      : {
          v: 1,
          ok: false,
          error: {
            code: "unavailable",
            message:
              "This backend has not registered its SSH drain handler yet; nothing was drained and no marker was written.",
          },
        };
  if (running) return { v: 1, ok: true, status: "busy" };
  running = true;
  try {
    return await active(request);
  } finally {
    running = false;
  }
}

export function drainStatusFromError(status: BackendDrainStatus): BackendDrainResponse {
  return { v: 1, ok: true, status };
}
