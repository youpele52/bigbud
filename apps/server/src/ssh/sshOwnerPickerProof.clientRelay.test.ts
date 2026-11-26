import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { openRemoteBackendRelayProfileOwner } from "../remote-backend/clientRelay.profileOwner.ts";
import type { ClientRelayOwnerLease } from "../remote-backend/clientRelay.ssh.owner.ts";
import { encodeLocalSupervisorServiceConfig } from "../remote-backend/localSupervisorService.config.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

const enabled =
  process.platform === "linux" && process.env.BIGBUD_TEST_SSH_OWNER_PICKER_PROOF === "1";
const pathFromHere = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const privateFixtureToken = "disposable-fixture-token";
const authorityId = "a".repeat(32);
const dummySha = "b".repeat(64);

async function pin(file: string, destination: string, mode: number) {
  await copyFile(file, destination);
  await chmod(destination, mode);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(destination)) digest.update(chunk);
  return digest.digest("hex");
}

async function stagedRelay(root: string) {
  const installed = path.join(root, "installed");
  await mkdir(installed, { mode: 0o700 });
  const nodeBinary = path.join(installed, "node");
  const helperEntry = path.join(installed, "remoteBackendClientRelay.mjs");
  const nodeSha256 = await pin(process.execPath, nodeBinary, 0o500);
  const helperSha256 = await pin(
    pathFromHere("../../dist/remote-client-relay/remoteBackendClientRelay.mjs"),
    helperEntry,
    0o400,
  );
  return { nodeBinary, nodeSha256, helperEntry, helperSha256, authorityId };
}

async function receiverPaths(home: string, nodeBinary: string, nodeSha256: string) {
  const service = path.join(home, ".bigbud", "backend-services", authorityId);
  const base = path.join(home, "backend");
  const state = path.join(base, "userdata");
  await mkdir(service, { recursive: true, mode: 0o700 });
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(path.join(service, "client-token"), privateFixtureToken, { mode: 0o600 });
  await writeFile(
    path.join(service, "config-v1"),
    encodeLocalSupervisorServiceConfig({
      version: "1",
      authority: authorityId,
      home,
      backend_home: base,
      rust_binary: path.join(home, "agent"),
      rust_sha256: dummySha,
      rust_state: path.join(home, "runtime"),
      node_binary: nodeBinary,
      node_sha256: nodeSha256,
      backend_entry: path.join(home, "server.mjs"),
      backend_sha256: dummySha,
      receipt_sha256: dummySha,
      restart: "yes",
      launch_attempt: "fixture",
      prior_epoch: "fresh",
      launch_boot: "boot",
      expected_installation_fingerprint: `sha256:${dummySha}`,
      authority_reservation_sha256: dummySha,
    }),
    { mode: 0o600 },
  );
  return path.join(state, "remote-backend.sock");
}

it.skipIf(!enabled)(
  "uses a real pinned Linux relay helper over Rust-owned SSH and confirms its local reap",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture();
    const body = Buffer.from(Array.from({ length: 150 * 1024 }, (_, index) => index % 251));
    const seen: string[] = [];
    const server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${privateFixtureToken}`) {
        response.writeHead(401).end();
        return;
      }
      seen.push(request.url ?? "");
      response.end(body);
    });
    try {
      const deployment = await stagedRelay(fixture.root);
      const socketPath = await receiverPaths(
        fixture.home,
        deployment.nodeBinary,
        deployment.nodeSha256,
      );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o600);
      const binary = await fixture.installOwner(
        pathFromHere("../../../../target/debug/bigbud-ssh-owner"),
      );
      const executionTargetId = `ssh:${new URLSearchParams({ host: fixture.loopback, port: String(fixture.port), user: fixture.user })}`;
      await storageScope(path.join(fixture.root, "relay-proof.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            binary,
            sql,
            profileBinding: randomBytes(32),
            targetId: executionTargetId,
            lockFile: path.join(fixture.root, "owner.lock"),
            sshBinary: fixture.ssh,
            keyscanBinary: fixture.keyscan,
            host: fixture.loopback,
            port: fixture.port,
            user: fixture.user,
            identityFile: fixture.identity,
            knownHostsFile: fixture.knownHosts,
            clientRelayFixture: deployment,
          });
          try {
            const signal = new AbortController().signal;
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired") throw new Error("Expected explicit approval");
            await owner.approveTrust(trust.challenge);
            await expect(
              owner.openClientRelay(
                { executionTargetId, deployment: { ...deployment, helperSha256: "f".repeat(64) } },
                signal,
              ),
            ).rejects.toMatchObject({ code: "operationDenied" });
            let retained: ClientRelayOwnerLease | undefined;
            const local = await openRemoteBackendRelayProfileOwner(
              {
                executionTargetId,
                deployment,
                profile: {
                  profileId: "isolated-relay",
                  label: "Private fixture",
                  identity: {
                    authority: { authorityId, keyEpoch: 1, keyFingerprint: `sha256:${dummySha}` },
                    installationFingerprint: `sha256:${dummySha}`,
                  },
                },
              },
              [],
              signal,
              {
                async openClientRelay(input, signal) {
                  retained = await owner.openClientRelay(input, signal);
                  return retained;
                },
              },
            );
            try {
              const result = await fetch(`${local.baseUrl}/asset`, {
                headers: {
                  authorization: `Bearer ${local.localCredential}`,
                  "x-bigbud-client-rpc-revision": "1",
                },
              });
              expect(result.status).toBe(200);
              expect(Buffer.from(await result.arrayBuffer())).toEqual(body);
              expect(seen).toEqual(["/asset"]);
              expect(retained).toBeDefined();
            } finally {
              await local.dispose();
            }
            await expect(retained?.exit).resolves.toMatchObject({
              kind: expect.stringMatching(/^(exited|signaled)$/),
            });
            await expect(
              owner.openClientRelay({ executionTargetId, deployment }, signal),
            ).rejects.toMatchObject({ code: "operationDenied" });
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await fixture.dispose();
    }
  },
  60_000,
);
