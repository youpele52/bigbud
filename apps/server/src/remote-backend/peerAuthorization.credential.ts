/**
 * Pure peer credential and allow-list parsing (WP-8B/8C), shared by the worker peer router and
 * the standalone forced-command helper. No Effect services, persistence or server composition.
 *
 * @module peerAuthorization.credential
 */
import type { PeerAction } from "@bigbud/contracts/server/remotePeer.ts";
import {
  PEER_CREDENTIAL_HEADERS,
  PEER_ROUTE_PATHS,
} from "@bigbud/contracts/constants/remotePeer.constant.ts";

export interface PeerCredential {
  readonly grantId: string;
  readonly coordinatorAuthorityId: string;
  readonly keyFingerprint: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const AUTHORITY = /^[0-9a-f]{32}$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;

const single = (value: string | ReadonlyArray<string> | undefined) =>
  typeof value === "string" ? value : undefined;

/** Strict parse; any missing, repeated or malformed value yields undefined. */
export function readPeerCredential(
  headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
): PeerCredential | undefined {
  const grantId = single(headers[PEER_CREDENTIAL_HEADERS.grant]);
  const coordinatorAuthorityId = single(headers[PEER_CREDENTIAL_HEADERS.coordinator]);
  const keyFingerprint = single(headers[PEER_CREDENTIAL_HEADERS.keyFingerprint]);
  if (
    !grantId ||
    !UUID.test(grantId) ||
    !coordinatorAuthorityId ||
    !AUTHORITY.test(coordinatorAuthorityId) ||
    !keyFingerprint ||
    !FINGERPRINT.test(keyFingerprint)
  )
    return undefined;
  return { grantId, coordinatorAuthorityId, keyFingerprint };
}

const ACTION_BY_PATH = new Map<string, PeerAction>(
  (Object.entries(PEER_ROUTE_PATHS) as Array<[PeerAction, string]>).map(([action, path]) => [
    path,
    action,
  ]),
);

/** The allow-list: POST to one of exactly four paths, without query or fragment. */
export function peerActionForRequest(method: string, url: string): PeerAction | undefined {
  if (method !== "POST" || !url.startsWith("/") || url.includes("?") || url.includes("#"))
    return undefined;
  return ACTION_BY_PATH.get(url);
}
