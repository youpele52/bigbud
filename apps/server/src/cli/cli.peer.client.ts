/**
 * `bigbud peer` client (WP-8C): owner-socket grant administration plus the worker's
 * forced-command `authorized_keys` line. Grant: the backend issues first, then the restricted line
 * is written. Revoke: the line is removed first (cutting SSH reach even when the backend is down),
 * then the backend revokes the grant.
 *
 * @module cli.peer.client
 */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  PEER_GRANT_OWNER_MAX_BYTES,
  PEER_GRANT_OWNER_PATH,
} from "@bigbud/contracts/constants/remotePeer.constant.ts";
import type { PeerActions, PeerPermissionCeiling } from "@bigbud/contracts/server/remotePeer.ts";
import {
  PeerGrantOwnerRefusal,
  PeerGrantOwnerRequest,
  PeerGrantOwnerResult,
  type PeerGrantOwnerRefusalCode,
  type PeerGrantOwnerResult as Result,
} from "@bigbud/contracts/server/remotePeer.wire.ts";
import * as Schema from "effect/Schema";

import { parsePeerPublicKey } from "../peer-orchestration/peerSshKey.ts";
import {
  mergePeerAuthorizedKeys,
  peerAuthorizedKeysLine,
  removePeerAuthorizedKeys,
  updateAuthorizedKeys,
} from "../remote-backend/peerAuthorizedKeys.ts";
import { sendOwnerSocketRequest, withOwnerSocketCredentials } from "./cli.mobile.transport.ts";

export type PeerGrantReply =
  | { readonly ok: true; readonly value: Result }
  | { readonly ok: false; readonly refused: PeerGrantOwnerRefusalCode };

const unavailable = () => new Error("Owner peer grant control is unavailable.");
const strict = { onExcessProperty: "error" } as const;

async function send(authorityId: string, request: PeerGrantOwnerRequest): Promise<PeerGrantReply> {
  const body = JSON.stringify(Schema.encodeUnknownSync(PeerGrantOwnerRequest)(request));
  return withOwnerSocketCredentials(
    authorityId,
    30_000,
    unavailable,
    async (credentials, signal) => {
      const response = await sendOwnerSocketRequest(
        {
          path: PEER_GRANT_OWNER_PATH,
          body,
          maxBytes: Math.max(PEER_GRANT_OWNER_MAX_BYTES, 1 << 20),
        },
        credentials,
        unavailable,
        { signal, deadlineMs: 30_000 },
      );
      const json: unknown = JSON.parse(response.text);
      if (response.status === 200)
        return { ok: true, value: Schema.decodeUnknownSync(PeerGrantOwnerResult)(json, strict) };
      return {
        ok: false,
        refused: Schema.decodeUnknownSync(PeerGrantOwnerRefusal)(json, strict).refused,
      };
    },
  );
}

export const defaultAuthorizedKeysFile = () => join(homedir(), ".ssh", "authorized_keys");

/** The installed graph's private Node and the peer helper beside the running entry. */
export async function resolvePeerHelperPaths(overrides: {
  readonly nodeBinary?: string | undefined;
  readonly helperEntry?: string | undefined;
}) {
  const entry = process.argv[1];
  const nodeBinary = await realpath(overrides.nodeBinary ?? process.execPath);
  const helperEntry = await realpath(
    overrides.helperEntry ??
      join(dirname(entry ?? "/nonexistent"), "remote-peer-relay/remoteBackendPeerRelay.mjs"),
  );
  for (const path of [nodeBinary, helperEntry])
    if (!(await stat(path)).isFile()) throw new Error(`Peer helper path is not a file: ${path}`);
  return { nodeBinary, helperEntry };
}

export async function grantPeer(input: {
  readonly authorityId: string;
  readonly coordinatorAuthorityId: string;
  readonly publicKey: string;
  readonly actions: PeerActions;
  readonly ceiling: PeerPermissionCeiling;
  readonly expiresAt: string;
  readonly nodeBinary: string;
  readonly helperEntry: string;
  readonly authorizedKeysFile: string;
}): Promise<PeerGrantReply> {
  const key = parsePeerPublicKey(input.publicKey);
  // Validate the line shape before the backend records anything.
  peerAuthorizedKeysLine({
    ...input,
    workerAuthorityId: input.authorityId,
    grantId: "00000000-0000-4000-8000-000000000000",
  });
  const reply = await send(input.authorityId, {
    action: "issue",
    authorityId: input.authorityId,
    coordinatorAuthorityId: input.coordinatorAuthorityId,
    coordinatorKeyFingerprint: key.fingerprint,
    actions: input.actions,
    ceiling: input.ceiling,
    expiresAt: input.expiresAt,
  });
  if (!reply.ok) return reply;
  const grant = reply.value.grants[0];
  if (!grant) throw unavailable();
  const line = peerAuthorizedKeysLine({
    ...input,
    workerAuthorityId: grant.workerAuthorityId,
    grantId: grant.grantId,
  });
  await updateAuthorizedKeys(input.authorizedKeysFile, (existing) =>
    mergePeerAuthorizedKeys(existing, line),
  );
  return reply;
}

export async function revokePeer(input: {
  readonly authorityId: string;
  readonly grantId: string;
  readonly authorizedKeysFile: string;
}): Promise<PeerGrantReply & { readonly keyRemoval: "removed" | "absent" | "failed" }> {
  // Both steps always run: a failed key edit must not skip the authoritative backend revoke.
  const keyRemoval = await updateAuthorizedKeys(input.authorizedKeysFile, (existing) =>
    removePeerAuthorizedKeys(existing, input.grantId),
  ).then(
    (changed) => (changed ? ("removed" as const) : ("absent" as const)),
    () => "failed" as const,
  );
  const reply = await send(input.authorityId, {
    action: "revoke",
    authorityId: input.authorityId,
    grantId: input.grantId,
  });
  return { ...reply, keyRemoval };
}

export const listPeerGrants = (authorityId: string) =>
  send(authorityId, { action: "list", authorityId });
