/**
 * Rootful disposable Linux VM fixture for paired-relay evidence (U10, T-peer).
 *
 * WRITTEN-NOT-RUN in this checkout: it needs a disposable Linux VM, the packaged
 * owner binary and root. Opt in explicitly:
 *
 *   BIGBUD_TEST_PEER_RELAY_LINUX=1 \
 *   BIGBUD_SSH_OWNER_BIN=/abs/path/bigbud-ssh-owner \
 *   bun run --cwd apps/server vitest run src/peer-orchestration/peerRelay.linux.test.ts
 *
 * Runbook (inside the disposable VM only):
 *   1. Boot a throwaway Linux x64/arm64 image with system OpenSSH and Node.
 *   2. Copy the built `bigbud-ssh-owner` binary to a root-owned absolute path.
 *   3. Run the command above as root; the fixture creates `/tmp/bigbud-peer-relay-*`
 *      (0700) and tears it down. It never reuses a host sshd or host trust store.
 *   4. Record the VM image id, OpenSSH version, byte count and exit codes in the ledger.
 *
 * The root-UID guard is not weakened: the test only runs as root, the helper and
 * authorized_keys must stay root-owned and non-world-writable, and nothing is
 * chowned. Any other UID skips (written-not-run) instead of relaxing the guard.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import type { PeerPairing } from "@bigbud/contracts/server/remotePeer.pairing.ts";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeOwnedPeerRelaySshChannels } from "../remote-backend/peerRelay.ssh.owner.ts";
import {
  mergePeerAuthorizedKeys,
  peerAuthorizedKeysLine,
  updateAuthorizedKeys,
} from "../remote-backend/peerAuthorizedKeys.ts";
import { parsePeerPublicKey } from "./peerSshKey.ts";
import { startPickerProofOwner } from "../ssh/sshOwnerPickerProof.client.ts";
import { storageScope } from "../ssh/sshOwnerPickerProof.integration.ts";

const optIn = process.env.BIGBUD_TEST_PEER_RELAY_LINUX === "1";
const rootLinux = process.platform === "linux" && process.getuid?.() === 0;
const binary = process.env.BIGBUD_SSH_OWNER_BIN;
const enabled = optIn && rootLinux && Boolean(binary && binary.startsWith("/"));
const SSHD = "/usr/sbin/sshd";
const WORKER = "c".repeat(32);
const COORDINATOR = "b".repeat(32);
const GRANT = randomUUID();
const PAIRING = randomUUID();

let root = "";
let sshd: ChildProcess | undefined;
let port = 0;
let ready = false;
const keys = { host: "", otherHost: "", coordinator: "" };

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port: chosen } = server.address() as net.AddressInfo;
      server.close(() => resolve(chosen));
    });
  });

const listening = (candidate: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(candidate, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

async function keyPair(name: string) {
  const file = join(root, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file]);
  const line = execFileSync("cut", ["-d", " ", "-f", "1,2", `${file}.pub`])
    .toString()
    .trim();
  const blob = Buffer.from(line.split(/\s+/)[1]!, "base64");
  return {
    file,
    line,
    sha256: `sha256:${createHash("sha256").update(blob).digest("hex")}`,
    hostFingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
  };
}

beforeAll(async () => {
  if (!enabled || !existsSync(SSHD)) return;
  root = await mkdtemp(join(tmpdir(), "bigbud-peer-relay-"));
  const host = await keyPair("host-key");
  const other = await keyPair("other-host-key");
  const coordinator = await keyPair("coordinator");
  keys.host = host.line;
  keys.otherHost = other.line;
  keys.coordinator = coordinator.file;
  const helper = join(root, "helper.mjs");
  await writeFile(
    helper,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(join(root, "reached.json"))}, JSON.stringify(process.argv.slice(2)));\n` +
      `process.stdin.pipe(process.stdout);\n`,
    { mode: 0o700 },
  );
  const coordinatorPublicKey = await readFile(`${keys.coordinator}.pub`, "utf8");
  await updateAuthorizedKeys(join(root, "ssh", "authorized_keys"), (existing) =>
    mergePeerAuthorizedKeys(
      existing,
      peerAuthorizedKeysLine({
        nodeBinary: process.execPath,
        helperEntry: helper,
        workerAuthorityId: WORKER,
        grantId: GRANT,
        coordinatorAuthorityId: COORDINATOR,
        publicKey: coordinatorPublicKey,
      }),
    ),
  );
  port = await freePort();
  await writeFile(
    join(root, "sshd_config"),
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${join(root, "host-key")}`,
      `AuthorizedKeysFile ${join(root, "ssh", "authorized_keys")}`,
      "PidFile none",
      "UsePAM no",
      "StrictModes no",
      "PermitRootLogin prohibit-password",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
    ].join("\n"),
    { mode: 0o600 },
  );
  sshd = spawn(SSHD, ["-f", join(root, "sshd_config"), "-D", "-e"], { stdio: "ignore" });
  for (let attempt = 0; attempt < 40 && !ready; attempt++) {
    ready = await listening(port);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(join(root, "known_hosts"), `[127.0.0.1]:${port} ${keys.host}\n`, { mode: 0o600 });
}, 60_000);

afterAll(async () => {
  sshd?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!enabled)("rootful paired relay through the Rust owner (U10)", () => {
  it("keeps root ownership, refuses ordinary trust, and transfers bounded bytes", async (context) => {
    if (!ready) return context.skip();
    expect(process.getuid?.()).toBe(0);
    const helper = await lstat(join(root, "helper.mjs"));
    expect(helper.uid).toBe(0);
    expect(helper.mode & 0o022).toBe(0);
    const authorized = await lstat(join(root, "ssh", "authorized_keys"));
    expect(authorized.uid).toBe(0);

    const coordinator = parsePeerPublicKey(await readFile(`${keys.coordinator}.pub`, "utf8"));
    const pairing = {
      pairingId: PAIRING,
      label: "Linux VM worker",
      workerAuthorityId: WORKER,
      host: "127.0.0.1",
      port,
      user: "root",
      pinnedHostKey: keys.host,
      hostKeyFingerprint: `SHA256:${createHash("sha256")
        .update(Buffer.from(keys.host.split(/\s+/)[1]!, "base64"))
        .digest("base64")
        .replace(/=+$/, "")}`,
      hostKeyConfirmedAt: "2026-11-25T00:00:00Z",
      workspaceRoot: join(root, "workspace"),
      provider: "codex",
      runtimeMode: "full-access",
      coordinatorKeyFingerprint: coordinator.fingerprint,
      grantId: GRANT,
      grantRecordedAt: "2026-11-25T00:00:00Z",
      grantRevokedAt: null,
      createdAt: "2026-11-25T00:00:00Z",
      updatedAt: "2026-11-25T00:00:00Z",
    } satisfies PeerPairing;
    const targetId = `ssh:${new URLSearchParams({ host: "127.0.0.1", auth: "ssh-key", transport: "direct-ssh" })}`;
    await storageScope(join(root, "peer.sqlite"), (sql) =>
      Effect.promise(async () => {
        const owner = await startPickerProofOwner({
          binary: binary!,
          profileBinding: Buffer.from(randomUUID().replaceAll("-", ""), "hex"),
          targetId,
          lockFile: join(root, "owner.lock"),
          sql,
          sshBinary: "/usr/bin/ssh",
          keyscanBinary: "/usr/bin/ssh-keyscan",
          host: "127.0.0.1",
          port,
          user: "root",
          identityFile: keys.coordinator,
          knownHostsFile: join(root, "known_hosts"),
          workspaceRoot: join(root, "workspace"),
          peerRelayFixture: {
            pairingId: PAIRING,
            grantId: GRANT,
            workerAuthorityId: WORKER,
            hostKeyFingerprint: pairing.hostKeyFingerprint,
            coordinatorKeyFingerprint: pairing.coordinatorKeyFingerprint,
          },
        });
        try {
          // Ordinary host trust is a different authority and is refused here.
          await expect(owner.inspectTrust()).rejects.toMatchObject({ code: "operationDenied" });
          const relay = makeOwnedPeerRelaySshChannels(pairing, {
            openPeerRelay: owner.openPeerRelay,
            async resolvePeerRelayApproval(id) {
              return id === PAIRING
                ? { pairing, coordinatorKeyFingerprint: pairing.coordinatorKeyFingerprint }
                : undefined;
            },
          });
          try {
            const channel = await relay.openChannel(new AbortController().signal);
            const data = Buffer.from(Array.from({ length: 130 * 1024 }, (_, i) => i % 251));
            const read = buffer(channel.stream);
            channel.stream.end(data);
            await expect(read).resolves.toEqual(data);
            await expect(channel.outcome).resolves.toBe("closed");
            expect(JSON.parse(await readFile(join(root, "reached.json"), "utf8"))).toEqual([
              WORKER,
              GRANT,
              COORDINATOR,
              coordinator.fingerprint,
            ]);
          } finally {
            await relay.dispose();
          }
          // A changed pin never reuses the saved approval.
          const changed = makeOwnedPeerRelaySshChannels(
            { ...pairing, pinnedHostKey: keys.otherHost },
            {
              openPeerRelay: owner.openPeerRelay,
              async resolvePeerRelayApproval() {
                return { pairing, coordinatorKeyFingerprint: pairing.coordinatorKeyFingerprint };
              },
            },
          );
          await expect(changed.openChannel(new AbortController().signal)).rejects.toMatchObject({
            code: "authorization-refused",
          });
        } finally {
          await owner.close();
        }
      }),
    );
  }, 60_000);
});
