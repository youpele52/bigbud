import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buffer, text } from "node:stream/consumers";
import { Effect } from "effect";
import { expect, it } from "vitest";
import type { PeerPairing } from "@bigbud/contracts/server/remotePeer.pairing.ts";

import { GRAPH_STAGE_SCRIPT } from "../remote-backend/deployment.fetch.ts";
import { makeDeploymentSshRunner } from "../remote-backend/deployment.ssh.ts";
import { makeOwnedPeerRelaySshChannels } from "../remote-backend/peerRelay.ssh.owner.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { deploymentForPickerProof } from "./sshOwnerPickerProof.deployment.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import {
  approve,
  live,
  signal,
  withFixture,
  withOwner,
} from "./sshOwnerPickerProof.scopedNative.fixture.ts";

it.skipIf(!live)(
  "opens an advertised receive-pack only, without a writable Git channel",
  () =>
    withFixture(async (fixture) => {
      const repositoryPath = path.join(fixture.root, "receive.git");
      for (const dir of ["objects/info", "objects/pack", "refs/heads", "refs/tags"])
        await mkdir(path.join(repositoryPath, dir), { recursive: true, mode: 0o700 });
      const head = "ref: refs/heads/main\n";
      const config = "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n";
      await writeFile(path.join(repositoryPath, "HEAD"), head, { mode: 0o600 });
      await writeFile(path.join(repositoryPath, "config"), config, { mode: 0o600 });
      const scope = {
        repositoryPath,
        sourceRef: "refs/heads/source",
        destinationRef: "refs/heads/main",
        sourceOid: "1".repeat(40),
      };
      await withOwner(
        fixture,
        { gitAdvertisementFixture: scope },
        async (owner, executionTargetId) => {
          await approve(owner);
          await expect(
            owner.openGitAdvertisement(
              { ...scope, destinationRef: "refs/heads/other", executionTargetId },
              signal(),
            ),
          ).rejects.toMatchObject({ code: "operationDenied" });
          const lease = await owner.openGitAdvertisement({ ...scope, executionTargetId }, signal());
          lease.pipes.stdin.end();
          const [stdout, stderr, exit] = await Promise.all([
            text(lease.pipes.stdout),
            text(lease.pipes.stderr),
            lease.exit,
          ]);
          expect(stdout).toContain("report-status");
          expect(stdout.endsWith("0000")).toBe(true);
          expect(stderr).toBe("");
          expect(exit).toEqual({ code: 0, signal: null });
          expect(await readFile(path.join(repositoryPath, "HEAD"), "utf8")).toBe(head);
          expect(await readFile(path.join(repositoryPath, "config"), "utf8")).toBe(config);
          expect(await readdir(path.join(repositoryPath, "refs/heads"))).toEqual([]);
        },
      );
    }),
  60_000,
);

async function publicKey(file: string) {
  const row = (await readFile(file, "utf8")).trim().split(/\s+/).slice(0, 2);
  if (row[0] !== "ssh-ed25519" || !row[1]) throw new Error("Invalid fixture key");
  return {
    line: row.join(" "),
    digest: createHash("sha256").update(Buffer.from(row[1], "base64")).digest(),
  };
}

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "uses pinned paired-worker trust and a dedicated forced command, with binary half-close",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ pairedPeerEcho: true });
    try {
      const worker = await publicKey(path.join(fixture.root, "host-key.pub"));
      const coordinator = await publicKey(`${fixture.identity}.pub`);
      await writeFile(fixture.knownHosts, `${fixture.host} ${worker.line}\n`);
      const pairingId = randomUUID();
      const grantId = randomUUID();
      const pairing = {
        pairingId,
        grantId,
        workerAuthorityId: "a".repeat(32),
        label: "Fixture peer",
        host: fixture.loopback,
        port: fixture.port,
        user: fixture.user,
        pinnedHostKey: worker.line,
        hostKeyFingerprint: `SHA256:${worker.digest.toString("base64").replace(/=+$/, "")}`,
        coordinatorKeyFingerprint: `sha256:${coordinator.digest.toString("hex")}`,
        hostKeyConfirmedAt: "2026-11-23T00:00:00Z",
        grantRecordedAt: "2026-11-23T00:00:00Z",
        grantRevokedAt: null,
        createdAt: "2026-11-23T00:00:00Z",
        updatedAt: "2026-11-23T00:00:00Z",
        workspaceRoot: fixture.home,
        provider: "codex",
        runtimeMode: "full-access",
      } satisfies PeerPairing;
      const options = await proofOptions(fixture);
      await fixture.start();
      await storageScope(path.join(fixture.root, "paired.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            peerRelayFixture: { ...pairing, grantId },
          });
          try {
            await expect(owner.inspectTrust()).rejects.toMatchObject({ code: "operationDenied" });
            await expect(
              owner.openPeerRelay(
                {
                  recipe: "paired-peer-forced-command",
                  pairing: { ...pairing, grantId, grantRevokedAt: null, port: fixture.port + 1 },
                },
                signal(),
              ),
            ).rejects.toMatchObject({ code: "operationDenied" });
            const relay = makeOwnedPeerRelaySshChannels(pairing, {
              openPeerRelay: owner.openPeerRelay,
              async resolvePeerRelayApproval(id) {
                return id === pairingId
                  ? { pairing, coordinatorKeyFingerprint: pairing.coordinatorKeyFingerprint }
                  : undefined;
              },
            });
            try {
              const channel = await relay.openChannel(signal());
              const data = Buffer.from(Array.from({ length: 130 * 1024 }, (_, i) => i % 251));
              const read = buffer(channel.stream);
              channel.stream.end(data);
              await expect(read).resolves.toEqual(data);
              await expect(channel.outcome).resolves.toBe("closed");
            } finally {
              await relay.dispose();
            }
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);

it.skipIf(!live)(
  "creates one empty private deployment stage in the approved fixture only",
  () =>
    withFixture(async (fixture) => {
      const root = path.join(fixture.root, "deployment-graphs");
      await mkdir(root, { mode: 0o700 });
      const requestId = randomUUID();
      const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
      const action = {
        requestId,
        installName: `0.1.0-${architecture}-unknown-linux-gnu-${"a".repeat(16)}`,
        archiveSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
      };
      const stagePath = path.join(root, `.staging-${requestId}`);
      const command = (manifestSha256: string) => ({
        command: "/bin/sh",
        args: [
          "-c",
          GRAPH_STAGE_SCRIPT,
          "sh",
          "begin",
          requestId,
          action.installName,
          action.archiveSha256,
          manifestSha256,
        ],
        timeoutMs: 60_000,
      });
      await withOwner(
        fixture,
        { deploymentStageFixture: { ...action, root } },
        async (owner, target) => {
          await approve(owner);
          const run = makeDeploymentSshRunner({
            kind: "owner",
            owner: deploymentForPickerProof(owner, { fixtureStage: true }),
          });
          const begin = (manifestSha256: string) => run(target, command(manifestSha256), signal());
          await expect(begin("c".repeat(64))).rejects.toThrow("owner refused");
          expect(await readdir(root)).toEqual([]);
          await expect(begin(action.manifestSha256)).resolves.toMatchObject({
            code: 0,
            stdout: "staged\n",
          });
          expect((await stat(stagePath)).mode & 0o777).toBe(0o700);
          expect(await readdir(stagePath)).toEqual([]);
          await expect(begin(action.manifestSha256)).rejects.toThrow("owner refused");
          expect(await readdir(root)).toEqual([`.staging-${requestId}`]);
        },
      );
      const marker = path.join(stagePath, "existing-synthetic-marker");
      await writeFile(marker, "unchanged", { mode: 0o600 });
      await withOwner(
        fixture,
        { deploymentStageFixture: { ...action, root } },
        async (owner, target) => {
          const run = makeDeploymentSshRunner({
            kind: "owner",
            owner: deploymentForPickerProof(owner, { fixtureStage: true }),
          });
          await expect(
            run(target, command(action.manifestSha256), signal()),
          ).resolves.toMatchObject({ code: 73 });
          expect(await readFile(marker, "utf8")).toBe("unchanged");
        },
        { reuseLauncher: true },
      );
    }),
  60_000,
);
