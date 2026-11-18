import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  FakeThread,
  FakeWorker,
  makePeerTestDeps,
  peerTestLayer,
  PIN,
} from "../orchestration-tools/peerDispatch.test.helpers.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { peerDispatchFixture, WORKER_AUTHORITY } from "./peerFixtures.test.helpers.ts";
import { handlePeerPairingRequest, type PeerPairingDeps } from "./peerPairing.ts";
import { parseKeyscanOutput } from "./peerCoordinator.transport.ts";

const errorCode = (error: unknown) => (error as { readonly code?: string }).code;
const GRANT = "00000001-0000-4000-8000-000000000042";
const save = {
  action: "save" as const,
  label: "worker-one",
  workerAuthorityId: WORKER_AUTHORITY,
  host: "w1.example.test",
  port: 22,
  user: "bigbud",
  pinnedHostKey: PIN,
  confirmPin: true as const,
  workspaceRoot: "/srv/my work",
  provider: "codex" as const,
  runtimeMode: "approval-required" as const,
};

const makeDeps = Effect.fn("makeDeps")(function* () {
  yield* runMigrations();
  const keyDirectory = yield* Effect.promise(async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "peer-pairing-")), "key");
    await mkdir(dir, { mode: 0o700 });
    return dir;
  });
  const coordinator = yield* makePeerTestDeps(new FakeWorker(), new FakeThread());
  const kicked: string[] = [];
  const deps: PeerPairingDeps = {
    coordinator,
    keyDirectory,
    kick: (worker) => Effect.sync(() => void kicked.push(worker)),
    scanHostKeys: async () => parseKeyscanOutput(`# w1 SSH-2.0\nw1.example.test ${PIN}\n`),
    ensureKey: async (dir) => {
      await writeFile(join(dir, "peer_ed25519.pub"), `${PIN} bigbud-peer\n`);
      return { publicKey: { fingerprint: "unused" } };
    },
  };
  return { deps, kicked };
});

it.live("revoke_independent_of_saved_connection", () =>
  Effect.gen(function* () {
    const { deps, kicked } = yield* makeDeps();
    // Saving needs the coordinator key first, then an explicitly confirmed pin.
    const noKey = yield* Effect.flip(handlePeerPairingRequest(deps, save));
    assert.strictEqual(errorCode(noKey), "key-unavailable");
    const keyed = yield* handlePeerPairingRequest(deps, { action: "ensure-key" });
    assert.match(keyed.coordinator.fingerprint ?? "", /^sha256:[0-9a-f]{64}$/);
    const scanned = yield* handlePeerPairingRequest(deps, {
      action: "scan-host-key",
      host: save.host,
      port: 22,
    });
    assert.strictEqual(scanned.scannedHostKeys?.[0]?.pinnedHostKey, PIN);
    assert.match(scanned.scannedHostKeys?.[0]?.fingerprint ?? "", /^SHA256:[A-Za-z0-9+/]+$/);

    const saved = yield* handlePeerPairingRequest(deps, save);
    const pairing = saved.pairings[0]!;
    assert.strictEqual(pairing.state, "awaiting-grant");
    assert.isNull(pairing.revokeCommand);
    assert.strictEqual(
      pairing.grantCommand,
      `bigbud peer grant --authority ${WORKER_AUTHORITY} --coordinator ${"a".repeat(32)} --public-key ./peer_ed25519.pub --workspace '/srv/my work' --provider codex --runtime-mode approval-required`,
    );

    const granted = yield* handlePeerPairingRequest(deps, {
      action: "record-grant",
      pairingId: pairing.pairingId,
      grantId: GRANT,
    });
    assert.strictEqual(granted.pairings[0]!.state, "active");
    assert.deepStrictEqual(kicked, [WORKER_AUTHORITY]);

    // Revoke keeps the saved connection and its pin, and shows the worker-side revoke command.
    const revoked = yield* handlePeerPairingRequest(deps, {
      action: "revoke",
      pairingId: pairing.pairingId,
    });
    const after = revoked.pairings[0]!;
    assert.strictEqual(after.state, "revoked");
    assert.strictEqual(after.host, save.host);
    assert.strictEqual(after.pinnedHostKey, PIN);
    assert.strictEqual(
      after.revokeCommand,
      `bigbud peer revoke --authority ${WORKER_AUTHORITY} --grant ${GRANT}`,
    );

    // Re-granting reuses the saved connection without re-entering it.
    const regranted = yield* handlePeerPairingRequest(deps, {
      action: "record-grant",
      pairingId: pairing.pairingId,
      grantId: GRANT.replace("42", "43"),
    });
    assert.strictEqual(regranted.pairings[0]!.state, "active");
    // A ceiling change under an active grant is refused (revoke first).
    const conflict = yield* Effect.flip(
      handlePeerPairingRequest(deps, { ...save, provider: "claudeAgent" }),
    );
    assert.strictEqual(errorCode(conflict), "pairing-conflict");

    // Deleting the saved connection is separate and does not need a revoke first.
    const deleted = yield* handlePeerPairingRequest(deps, {
      action: "delete-connection",
      pairingId: pairing.pairingId,
    });
    assert.lengthOf(deleted.pairings, 0);
  }).pipe(Effect.provide(peerTestLayer)),
);

it.live("a saved connection with unsettled dispatches cannot be deleted", () =>
  Effect.gen(function* () {
    const { deps } = yield* makeDeps();
    yield* handlePeerPairingRequest(deps, { action: "ensure-key" });
    const saved = yield* handlePeerPairingRequest(deps, save);
    const pairing = saved.pairings[0]!;
    yield* handlePeerPairingRequest(deps, {
      action: "record-grant",
      pairingId: pairing.pairingId,
      grantId: GRANT,
    });
    yield* deps.coordinator.dispatches.insert(peerDispatchFixture(1));
    const busy = yield* Effect.flip(
      handlePeerPairingRequest(deps, { action: "delete-connection", pairingId: pairing.pairingId }),
    );
    assert.strictEqual(errorCode(busy), "pairing-busy");
  }).pipe(Effect.provide(peerTestLayer)),
);
