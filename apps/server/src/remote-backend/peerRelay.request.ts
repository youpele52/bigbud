/**
 * One coordinator peer request over an SSH channel stream (WP-8C). Bounded JSON in and out, a
 * single absolute deadline, no redirects and no credential headers: the worker's forced command
 * supplies the peer identity.
 *
 * @module peerRelay.request
 */
import * as http from "node:http";
import type { Duplex } from "node:stream";

import {
  PEER_REQUEST_MAX_BYTES,
  PEER_ROUTE_PATHS,
} from "@bigbud/contracts/constants/remotePeer.constant.ts";
import type { PeerAction } from "@bigbud/contracts/server/remotePeer.ts";

const RESPONSE_MAX_BYTES = 256 * 1024;

export interface PeerRelayResponse {
  readonly status: number;
  readonly body: unknown;
}

export function sendPeerRequest(
  stream: Duplex,
  action: PeerAction,
  body: unknown,
  options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
): Promise<PeerRelayResponse> {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > PEER_REQUEST_MAX_BYTES)
    return Promise.reject(new Error("Peer request exceeds the size limit."));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: PeerRelayResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) {
        request.destroy();
        reject(error);
      } else resolve(value!);
    };
    const abort = () => finish(new Error("Peer request aborted."));
    const timer = setTimeout(
      () => finish(new Error("Peer request timed out.")),
      options.deadlineMs ?? 35_000,
    );
    const request = http.request({
      createConnection: () => stream,
      method: "POST",
      path: PEER_ROUTE_PATHS[action],
      headers: {
        host: "peer.invalid",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) return abort();
    request.once("error", (error) => finish(error));
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > RESPONSE_MAX_BYTES) finish(new Error("Peer response exceeds the size limit."));
        else chunks.push(chunk);
      });
      response.once("error", (error) => finish(error));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const json = (response.headers["content-type"] ?? "").startsWith("application/json");
        try {
          finish(undefined, {
            status: response.statusCode ?? 0,
            body: json ? JSON.parse(text) : text,
          });
        } catch {
          finish(new Error("Peer response was not valid JSON."));
        }
      });
    });
    request.end(payload);
  });
}
