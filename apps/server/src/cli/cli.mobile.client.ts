import * as http from "node:http";
import { homedir } from "node:os";
import {
  REMOTE_BACKEND_CLIENT_RPC_REVISION,
  REMOTE_BACKEND_CLIENT_RPC_REVISION_HEADER,
} from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import { readClientRelayCredentials } from "../remote-backend/clientRelay.credentials.ts";
import {
  decodeMobileOwnerPairingInput,
  decodeMobileOwnerPairingResult,
  MOBILE_OWNER_PAIRING_MAX_BYTES,
  MOBILE_OWNER_PAIRING_PATH,
  type MobileOwnerPairingInput,
} from "../remote-backend/mobileOwnerPairing.protocol.ts";

const unavailable = () => new Error("Owner mobile pairing is unavailable.");
/** Private UDS-only transport. No redirects, retry, environment credential or caller-selected path. */
export function sendMobileOwnerPairingRequest(
  input: MobileOwnerPairingInput,
  credentials: { socketPath: string; token: string },
  options: { signal?: AbortSignal; deadlineMs?: number } = {},
) {
  return new Promise<ReturnType<typeof decodeMobileOwnerPairingResult>>((resolve, reject) => {
    let done = false;
    let response: http.IncomingMessage | undefined;
    let request: http.ClientRequest | undefined;
    const finish = (value?: ReturnType<typeof decodeMobileOwnerPairingResult>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      response?.destroy();
      request?.destroy();
      if (value) resolve(value);
      else reject(unavailable());
    };
    const abort = () => finish();
    const timer = setTimeout(abort, options.deadlineMs ?? 10_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) return abort();
    try {
      const snapshot = decodeMobileOwnerPairingInput(input);
      const body = JSON.stringify(snapshot);
      request = http.request(
        {
          maxHeaderSize: MOBILE_OWNER_PAIRING_MAX_BYTES,
          socketPath: credentials.socketPath,
          path: MOBILE_OWNER_PAIRING_PATH,
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.token}`,
            [REMOTE_BACKEND_CLIENT_RPC_REVISION_HEADER]: String(REMOTE_BACKEND_CLIENT_RPC_REVISION),
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (incoming) => {
          response = incoming;
          if (incoming.statusCode !== 200) return finish();
          const chunks: Buffer[] = [];
          let bytes = 0;
          incoming.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MOBILE_OWNER_PAIRING_MAX_BYTES) return finish();
            chunks.push(chunk);
          });
          incoming.once("aborted", abort);
          incoming.once("error", abort);
          incoming.once("end", () => {
            if (done) return;
            try {
              finish(
                decodeMobileOwnerPairingResult(
                  JSON.parse(Buffer.concat(chunks).toString("utf8")),
                  snapshot,
                ),
              );
            } catch {
              finish();
            }
          });
        },
      );
      request.once("error", abort);
      request.end(body);
    } catch {
      finish();
    }
  });
}

/** Remote account helper reads its own private config/token; no credential parameter reaches CLI. */
export async function createMobileOwnerPairing(value: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let abortListener: (() => void) | undefined;
  try {
    const input = decodeMobileOwnerPairingInput(value);
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(unavailable());
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    const credentials = await Promise.race([
      readClientRelayCredentials(homedir(), input.authorityId),
      aborted,
    ]);
    controller.signal.throwIfAborted();
    return await sendMobileOwnerPairingRequest(input, credentials, { signal: controller.signal });
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}
