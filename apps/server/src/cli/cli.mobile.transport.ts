import * as http from "node:http";
import { homedir } from "node:os";
import {
  REMOTE_BACKEND_CLIENT_RPC_REVISION,
  REMOTE_BACKEND_CLIENT_RPC_REVISION_HEADER,
} from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import { readClientRelayCredentials } from "../remote-backend/clientRelay.credentials.ts";

export interface OwnerSocketCredentials {
  readonly socketPath: string;
  readonly token: string;
}
export interface OwnerSocketOptions {
  readonly signal?: AbortSignal;
  /** One absolute deadline covering connect, headers and the whole body. */
  readonly deadlineMs?: number;
}
export interface OwnerSocketResponse {
  readonly status: number;
  readonly text: string;
}

/**
 * Private UDS-only JSON POST to the authenticated backend owner socket. No redirects (any 3xx is
 * refused), retry, environment credential or caller-selected host. Bounded headers and body; every
 * failure rejects with the caller's generic error so neither token nor server prose leaks.
 */
export function sendOwnerSocketRequest(
  request: { readonly path: string; readonly body: string; readonly maxBytes: number },
  credentials: OwnerSocketCredentials,
  unavailable: () => Error,
  options: OwnerSocketOptions = {},
) {
  return new Promise<OwnerSocketResponse>((resolve, reject) => {
    let done = false;
    let response: http.IncomingMessage | undefined;
    let outgoing: http.ClientRequest | undefined;
    const finish = (value?: OwnerSocketResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      response?.destroy();
      outgoing?.destroy();
      if (value) resolve(value);
      else reject(unavailable());
    };
    const abort = () => finish();
    const timer = setTimeout(abort, options.deadlineMs ?? 10_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) return abort();
    try {
      outgoing = http.request(
        {
          maxHeaderSize: request.maxBytes,
          socketPath: credentials.socketPath,
          path: request.path,
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.token}`,
            [REMOTE_BACKEND_CLIENT_RPC_REVISION_HEADER]: String(REMOTE_BACKEND_CLIENT_RPC_REVISION),
            "content-type": "application/json",
            "content-length": Buffer.byteLength(request.body),
          },
        },
        (incoming) => {
          response = incoming;
          const status = incoming.statusCode ?? 0;
          if (status < 200 || (status >= 300 && status < 400)) return finish();
          const chunks: Buffer[] = [];
          let bytes = 0;
          incoming.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > request.maxBytes) return finish();
            chunks.push(chunk);
          });
          incoming.once("aborted", abort);
          incoming.once("error", abort);
          incoming.once("end", () => {
            if (done) return;
            try {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
              finish({ status, text });
            } catch {
              finish();
            }
          });
        },
      );
      outgoing.once("error", abort);
      outgoing.end(request.body);
    } catch {
      finish();
    }
  });
}

/**
 * Reads this account's own private config/token for `authorityId` and runs `use` under one
 * absolute deadline. Any failure, including a credential read, becomes the caller's generic error.
 */
export async function withOwnerSocketCredentials<A>(
  authorityId: string,
  deadlineMs: number,
  unavailable: () => Error,
  use: (credentials: OwnerSocketCredentials, signal: AbortSignal) => Promise<A>,
): Promise<A> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let abortListener: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(unavailable());
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    const credentials = await Promise.race([
      readClientRelayCredentials(homedir(), authorityId),
      aborted,
    ]);
    controller.signal.throwIfAborted();
    return await use(credentials, controller.signal);
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}
