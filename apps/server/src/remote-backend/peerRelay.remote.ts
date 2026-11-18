/**
 * Worker-side SSH forced-command helper core (WP-8C). One SSH channel's stdio carries HTTP to the
 * owner-private peer socket only. The peer identity comes from the helper's fixed argv (written
 * into `authorized_keys` for exactly one key), never from the coordinator: any credential,
 * authorization or cookie header it sends is dropped, and anything outside the four peer routes
 * is refused before reaching the socket.
 *
 * @module peerRelay.remote
 */
import * as http from "node:http";
import type { Duplex } from "node:stream";

import {
  PEER_CREDENTIAL_HEADERS,
  PEER_REQUEST_MAX_BYTES,
} from "@bigbud/contracts/constants/remotePeer.constant.ts";

import { makeClientRelayHttpProxy } from "./clientRelay.http.ts";
import { peerActionForRequest, type PeerCredential } from "./peerAuthorization.credential.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export interface PeerRelayArguments {
  readonly workerAuthorityId: string;
  readonly credential: PeerCredential;
}

/** `<worker authority> <grant id> <coordinator authority> <sha256:key fingerprint>`, exactly. */
export function parsePeerRelayArguments(argv: ReadonlyArray<string>): PeerRelayArguments {
  const [workerAuthorityId, grantId, coordinatorAuthorityId, keyFingerprint] = argv;
  if (
    argv.length !== 4 ||
    !/^[0-9a-f]{32}$/.test(workerAuthorityId ?? "") ||
    !UUID.test(grantId ?? "") ||
    !/^[0-9a-f]{32}$/.test(coordinatorAuthorityId ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(keyFingerprint ?? "")
  )
    throw new Error("Invalid peer relay arguments.");
  return {
    workerAuthorityId: workerAuthorityId!,
    credential: {
      grantId: grantId!,
      coordinatorAuthorityId: coordinatorAuthorityId!,
      keyFingerprint: keyFingerprint!,
    },
  };
}

/** Only content framing passes; the credential is always the helper's own. */
export function peerRelayRequestHeaders(
  incoming: http.IncomingHttpHeaders,
  credential: PeerCredential,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  if (typeof incoming["content-type"] === "string")
    headers["content-type"] = incoming["content-type"];
  if (typeof incoming["content-length"] === "string")
    headers["content-length"] = incoming["content-length"];
  headers[PEER_CREDENTIAL_HEADERS.grant] = credential.grantId;
  headers[PEER_CREDENTIAL_HEADERS.coordinator] = credential.coordinatorAuthorityId;
  headers[PEER_CREDENTIAL_HEADERS.keyFingerprint] = credential.keyFingerprint;
  return headers;
}

function admitted(incoming: http.IncomingMessage, outgoing?: http.ServerResponse): boolean {
  const length = Number(incoming.headers["content-length"] ?? "0");
  const refuse = (status: number) => {
    outgoing?.writeHead(status, { "content-type": "text/plain" }).end();
    return false;
  };
  // Upgrades (no `outgoing`) and every non-peer route never reach the socket.
  if (!outgoing || !peerActionForRequest(incoming.method ?? "", incoming.url ?? ""))
    return refuse(404);
  if (incoming.headers["transfer-encoding"] !== undefined) return refuse(411);
  if (!Number.isSafeInteger(length) || length < 0 || length > PEER_REQUEST_MAX_BYTES)
    return refuse(413);
  return true;
}

/** Serves one SSH channel; resolves nothing and owns no listener, port or backend lifecycle. */
export function servePeerRelayStream(input: {
  readonly stream: Duplex;
  readonly socketPath: string;
  readonly credential: PeerCredential;
}) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 });
  const proxy = makeClientRelayHttpProxy({
    authorize: admitted,
    request: (incoming) =>
      http.request({
        socketPath: input.socketPath,
        method: "POST",
        path: incoming.url,
        headers: peerRelayRequestHeaders(incoming.headers, input.credential),
        agent,
      }),
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    agent.destroy();
    proxy.close();
    input.stream.destroy();
  };
  input.stream.once("error", close);
  input.stream.once("close", close);
  proxy.server.emit("connection", input.stream);
  return { close };
}
