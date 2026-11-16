import * as http from "node:http";
import * as https from "node:https";
import { Schema } from "effect";
import {
  RemoteBackendMobileDescriptor,
  REMOTE_BACKEND_HANDSHAKE_REVISION,
  REMOTE_BACKEND_MOBILE_RPC_REVISION,
} from "@bigbud/contracts/server/remoteBackendHandshake";
import { compareRemoteBackendIdentity } from "@bigbud/shared/remoteBackendIdentity";
import { canonicalMobileOwnerOrigin } from "./mobileOwnerPairing.protocol.ts";

export const MOBILE_GATEWAY_PROBE_DEADLINE_MS = 2_000;
const MAX_BYTES = 16 * 1024;
const unavailable = () => new Error("Mobile gateway identity probe did not complete.");
const decode = Schema.decodeUnknownSync(RemoteBackendMobileDescriptor);

/**
 * Probe only an already owned, verified gateway child. This proves its upstream identity,
 * not child provenance, current consent, Serve configuration or off-network reachability.
 * mobileCapable may still be false while the owning lifecycle completes bootstrap.
 */
export async function probeMobileGateway(input: {
  readonly port: number;
  readonly externalOrigin: string;
  readonly expected: RemoteBackendMobileDescriptor;
  readonly signal: AbortSignal;
}): Promise<void> {
  return probe(input, false);
}

/** Default Node TLS validation, exact HTTPS origin, no credentials or redirects. */
export async function probeMobileGatewayHttps(input: {
  readonly externalOrigin: string;
  readonly expected: RemoteBackendMobileDescriptor;
  readonly signal: AbortSignal;
}): Promise<void> {
  return probe({ ...input, port: 443 }, true);
}

async function probe(
  input: {
    readonly port: number;
    readonly externalOrigin: string;
    readonly expected: RemoteBackendMobileDescriptor;
    readonly signal: AbortSignal;
  },
  external: boolean,
): Promise<void> {
  let expected: RemoteBackendMobileDescriptor;
  let origin: URL;
  try {
    expected = structuredClone(decode(input.expected, { onExcessProperty: "error" }));
    origin = new URL(canonicalMobileOwnerOrigin(input.externalOrigin));
    if (
      !Number.isInteger(input.port) ||
      input.port < 1 ||
      input.port > 65535 ||
      (external && origin.port !== "") ||
      expected.handshakeRevision !== REMOTE_BACKEND_HANDSHAKE_REVISION ||
      expected.mobileRpcRevision !== REMOTE_BACKEND_MOBILE_RPC_REVISION
    )
      throw unavailable();
    input.signal.throwIfAborted();
  } catch {
    throw unavailable();
  }
  // Capture before asynchronous IO; a caller changing its configuration cannot retarget a probe.
  const port = input.port;
  const signal = input.signal;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    let request: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    const finish = (success = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      response?.destroy();
      request?.destroy();
      if (success && !signal.aborted) resolve();
      else reject(unavailable());
    };
    const abort = () => finish();
    const timer = setTimeout(abort, MOBILE_GATEWAY_PROBE_DEADLINE_MS);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    try {
      request = (external ? https.request : http.request)(
        {
          hostname: external ? origin.hostname : "127.0.0.1",
          port: external ? 443 : port,
          protocol: external ? "https:" : "http:",
          method: "GET",
          path: "/api/mobile/handshake",
          agent: false,
          maxHeaderSize: MAX_BYTES,
          headers: { host: origin.host, origin: origin.origin, accept: "application/json" },
        },
        (incoming) => {
          response = incoming;
          if (
            incoming.statusCode !== 200 ||
            incoming.headers["content-type"]?.split(";")[0]?.trim() !== "application/json" ||
            incoming.headers["content-encoding"] !== undefined
          )
            return finish();
          const chunks: Buffer[] = [];
          let length = 0;
          incoming.on("data", (chunk: Buffer) => {
            if (done) return;
            length += chunk.length;
            if (length > MAX_BYTES) return finish();
            chunks.push(chunk);
          });
          incoming.once("error", abort);
          incoming.once("aborted", abort);
          incoming.once("end", () => {
            if (done) return;
            try {
              const actual = decode(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
                onExcessProperty: "error",
              });
              finish(
                actual.handshakeRevision === expected.handshakeRevision &&
                  actual.mobileRpcRevision === expected.mobileRpcRevision &&
                  actual.backendVersion === expected.backendVersion &&
                  compareRemoteBackendIdentity(actual, expected) === "match",
              );
            } catch {
              finish();
            }
          });
        },
      );
      request.once("error", abort);
      request.end();
    } catch {
      finish();
    }
  });
}
