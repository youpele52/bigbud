/**
 * Coordinator pairing administration (M6 WP-8E) behind the `server.peerPairing` RPC.
 *
 * - The coordinator key is generated only on explicit request, then reused.
 * - Host keys are scanned for the user to compare; a pairing is saved only with `confirmPin`.
 * - Each pairing shows the exact `bigbud peer grant` command for the worker and, once a grant is
 *   recorded, the exact `bigbud peer revoke --grant <id>` command.
 * - Revoke clears the coordinator's use of the grant but keeps the saved connection; deleting the
 *   saved connection is separate and never revokes anything on the worker.
 *
 * @module peerPairing
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PeerPairingError,
  type PeerCoordinatorKey,
  type PeerPairing,
  type PeerPairingRequest,
  type PeerPairingResult,
  type PeerPairingView,
  type PeerScannedHostKey,
} from "@bigbud/contracts/server/remotePeer.pairing.ts";
import { Effect } from "effect";

import { isTerminalPeerDispatchState } from "./peerDispatch.transition.ts";
import type { PeerCoordinatorDeps } from "../orchestration-tools/peerDispatch.deps.ts";
import { sshHostKeyFingerprint } from "./peerCoordinator.transport.ts";
import { ensureCoordinatorPeerKey, parsePeerPublicKey } from "./peerSshKey.ts";

export interface PeerPairingDeps {
  readonly coordinator: PeerCoordinatorDeps;
  readonly keyDirectory: string;
  readonly kick: (workerAuthorityId: string) => Effect.Effect<void, Error>;
  readonly scanHostKeys: (host: string, port: number) => Promise<ReadonlyArray<PeerScannedHostKey>>;
  readonly ensureKey?: (
    directory: string,
  ) => Promise<{ readonly publicKey: { fingerprint: string } }>;
}

const fail = (code: PeerPairingError["code"], message: string) =>
  Effect.fail(new PeerPairingError({ code, message }));

/** POSIX single-quote quoting for values that may contain spaces. */
const shellQuote = (value: string) =>
  /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

export function peerGrantCommand(pairing: PeerPairing, coordinatorAuthorityId: string) {
  return [
    "bigbud peer grant",
    `--authority ${pairing.workerAuthorityId}`,
    `--coordinator ${coordinatorAuthorityId}`,
    "--public-key ./peer_ed25519.pub",
    `--workspace ${shellQuote(pairing.workspaceRoot)}`,
    `--provider ${pairing.provider}`,
    `--runtime-mode ${pairing.runtimeMode}`,
  ].join(" ");
}

export const peerRevokeCommand = (pairing: PeerPairing) =>
  pairing.grantId === null
    ? null
    : `bigbud peer revoke --authority ${pairing.workerAuthorityId} --grant ${pairing.grantId}`;

const readCoordinatorKey = async (
  keyDirectory: string,
  authorityId: string | null,
): Promise<PeerCoordinatorKey> => {
  const publicKeyFile = join(keyDirectory, "peer_ed25519.pub");
  const line = await readFile(publicKeyFile, "utf8").catch(() => null);
  if (line === null)
    return { authorityId, publicKey: null, publicKeyFile: null, fingerprint: null };
  const key = parsePeerPublicKey(line);
  return {
    authorityId,
    publicKey: `${key.type} ${key.base64} bigbud-peer`,
    publicKeyFile,
    fingerprint: key.fingerprint,
  };
};

const pairingState = (pairing: PeerPairing): PeerPairingView["state"] =>
  pairing.grantId === null ? "awaiting-grant" : pairing.grantRevokedAt ? "revoked" : "active";

const result = Effect.fn("peerPairing.result")(function* (
  deps: PeerPairingDeps,
  extra: Partial<Pick<PeerPairingResult, "scannedHostKeys">> = {},
) {
  const c = deps.coordinator;
  const coordinator = yield* Effect.tryPromise({
    try: () => readCoordinatorKey(deps.keyDirectory, c.coordinatorAuthorityId),
    catch: () => new PeerPairingError({ code: "key-unavailable", message: "Unreadable key." }),
  });
  const unsettled = yield* c.dispatches.listUnsettled(1_000);
  const pairings = (yield* c.pairings.list()).map(
    (pairing): PeerPairingView => ({
      ...pairing,
      state: pairingState(pairing),
      grantCommand: peerGrantCommand(pairing, c.coordinatorAuthorityId ?? "<coordinator>"),
      revokeCommand: peerRevokeCommand(pairing),
      setupError: c.setupErrors.get(pairing.workerAuthorityId) ?? null,
      unsettledDispatches: unsettled.filter(
        (d) =>
          d.worker.workerAuthorityId === pairing.workerAuthorityId &&
          !isTerminalPeerDispatchState(d.state),
      ).length,
    }),
  );
  return { coordinator, pairings, ...extra } satisfies PeerPairingResult;
});

const requirePairing = Effect.fn("peerPairing.require")(function* (
  deps: PeerPairingDeps,
  pairingId: string,
) {
  const pairing = yield* deps.coordinator.pairings.get(pairingId);
  return pairing ?? (yield* fail("pairing-unknown", "No saved connection with that id."));
});

export const handlePeerPairingRequest = Effect.fn("peerPairing.handle")(function* (
  deps: PeerPairingDeps,
  request: PeerPairingRequest,
) {
  const c = deps.coordinator;
  if (c.coordinatorAuthorityId === null)
    return yield* fail("unavailable", "Peer pairing is only available on a remote backend.");
  const now = c.now();
  switch (request.action) {
    case "status":
      return yield* result(deps);
    case "ensure-key": {
      yield* Effect.tryPromise({
        try: () => (deps.ensureKey ?? ensureCoordinatorPeerKey)(deps.keyDirectory),
        catch: (cause) =>
          new PeerPairingError({
            code: "key-unavailable",
            message: cause instanceof Error ? cause.message : "The key could not be created.",
          }),
      });
      return yield* result(deps);
    }
    case "scan-host-key": {
      const scannedHostKeys = yield* Effect.tryPromise({
        try: () => deps.scanHostKeys(request.host, request.port),
        catch: () =>
          new PeerPairingError({
            code: "host-key-scan-failed",
            message: `Could not read host keys from ${request.host}:${request.port}.`,
          }),
      });
      if (scannedHostKeys.length === 0)
        return yield* fail("host-key-scan-failed", "The host offered no usable host keys.");
      return yield* result(deps, { scannedHostKeys });
    }
    case "save": {
      if (request.confirmPin !== true)
        return yield* fail(
          "invalid-request",
          "Confirm the host key pin before saving; nothing was saved.",
        );
      const key = (yield* result(deps)).coordinator;
      if (!key.fingerprint)
        return yield* fail("key-unavailable", "Generate the coordinator key before pairing.");
      const existing = yield* c.pairings.findByWorker(request.workerAuthorityId);
      yield* c.pairings
        .save({
          connection: {
            pairingId: existing?.pairingId ?? c.newDispatchId(),
            label: request.label,
            workerAuthorityId: request.workerAuthorityId,
            host: request.host,
            port: request.port,
            user: request.user,
            pinnedHostKey: request.pinnedHostKey,
            hostKeyFingerprint: sshHostKeyFingerprint(request.pinnedHostKey),
            hostKeyConfirmedAt: now,
            workspaceRoot: request.workspaceRoot,
            provider: request.provider,
            runtimeMode: request.runtimeMode,
            coordinatorKeyFingerprint: key.fingerprint,
          },
          at: now,
        })
        .pipe(
          Effect.catchTag("PeerPairingConflict", (error) => fail("pairing-conflict", error.detail)),
        );
      // A re-confirmed pin clears an earlier host-identity setup error.
      yield* c.setupErrors.has(request.workerAuthorityId)
        ? deps.kick(request.workerAuthorityId)
        : Effect.void;
      return yield* result(deps);
    }
    case "record-grant": {
      const pairing = yield* requirePairing(deps, request.pairingId);
      yield* c.pairings.recordGrant(pairing.pairingId, request.grantId, now);
      yield* deps.kick(pairing.workerAuthorityId);
      return yield* result(deps);
    }
    case "revoke": {
      const pairing = yield* requirePairing(deps, request.pairingId);
      if (pairing.grantId === null)
        return yield* fail("invalid-request", "This connection has no grant to revoke.");
      yield* c.pairings.revoke(pairing.pairingId, now);
      return yield* result(deps);
    }
    case "delete-connection": {
      const pairing = yield* requirePairing(deps, request.pairingId);
      const unsettled = (yield* result(deps)).pairings.find(
        (view) => view.pairingId === pairing.pairingId,
      )?.unsettledDispatches;
      if (unsettled)
        return yield* fail(
          "pairing-busy",
          `${unsettled} delegated task(s) on this worker have not settled; cancel or wait first.`,
        );
      yield* c.pairings.remove(pairing.pairingId);
      return yield* result(deps);
    }
  }
});
