import * as fs from "node:fs/promises";
import * as http from "node:http";
import { join } from "node:path";
import { vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { makeRemoteBackendRelayLeases } from "./clientRelay.leases.ts";
import { openRemoteBackendRelayProfileOwner } from "./clientRelay.profileOwner.ts";
import type { ResolvedRemoteBackendRelayProfile } from "./clientRelay.profiles.ts";
import { encodeLocalSupervisorServiceConfig } from "./localSupervisorService.config.ts";
export interface RelayFixtureCalls {
  children: ChildProcess[];
  args: string[];
}
export async function makeLeaseFixture(
  calls: RelayFixtureCalls,
  cleanup: Array<() => void | Promise<void>>,
) {
  const home = await fs.mkdtemp("/tmp/bb-lse-");
  vi.stubEnv("HOME", home);
  const authorityId = "a".repeat(32),
    sha = "b".repeat(64),
    root = join(home, ".bigbud/backend-services", authorityId),
    base = join(home, "base"),
    state = join(base, "userdata");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const server = http.createServer((_request, response) => response.end("lease-output"));
  const peers = new Set<import("node:net").Socket>();
  server.on("connection", (peer) => {
    peers.add(peer);
    peer.once("close", () => peers.delete(peer));
  });
  await new Promise<void>((resolve) => server.listen(join(state, "remote-backend.sock"), resolve));
  await fs.chmod(join(state, "remote-backend.sock"), 0o600);
  await fs.writeFile(join(root, "client-token"), "fixture-private-upstream-token", { mode: 0o600 });
  await fs.writeFile(
    join(root, "config-v1"),
    encodeLocalSupervisorServiceConfig({
      version: "1",
      authority: authorityId,
      home,
      backend_home: base,
      rust_binary: join(home, "agent"),
      rust_sha256: sha,
      rust_state: join(home, "runtime"),
      node_binary: process.execPath,
      node_sha256: sha,
      backend_entry: join(home, "bin.mjs"),
      backend_sha256: sha,
      receipt_sha256: sha,
      restart: "yes",
      launch_attempt: "fixture",
      prior_epoch: "fresh",
      launch_boot: "boot",
      expected_installation_fingerprint: `sha256:${sha}`,
      authority_reservation_sha256: sha,
    }),
    { mode: 0o600 },
  );
  const helper = "/fixture-helper/remoteBackendClientRelay.mjs";
  calls.args = [helper, authorityId];
  const profile: ResolvedRemoteBackendRelayProfile = {
    profile: {
      profileId: "isolated-fixture",
      label: "Isolated fixture only",
      identity: {
        authority: { authorityId, keyEpoch: 1, keyFingerprint: `sha256:${sha}` },
        installationFingerprint: `sha256:${sha}`,
      },
    },
    executionTargetId: "ssh:isolated-fixture",
    deployment: {
      authorityId,
      nodeBinary: process.execPath,
      nodeSha256: sha,
      helperEntry: helper,
      helperSha256: sha,
    },
  };
  const active = new Set(["route:1", "route:2"]);
  const leases = makeRemoteBackendRelayLeases({
    profiles: {
      list: async () => ({ availability: "available", profiles: [profile.profile] }),
      resolve: async () => profile,
    },
    isCallerActive: async (caller) => active.has(caller),
    openProfile: (selected, signal) => openRemoteBackendRelayProfileOwner(selected, [], signal),
  });
  cleanup.push(async () => {
    await leases.dispose();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });
  return { leases, active, profile };
}
export async function fetchLease(lease: { baseUrl: string; localCredential: string }) {
  const response = await fetch(lease.baseUrl + "/asset", {
    headers: {
      authorization: `Bearer ${lease.localCredential}`,
      "x-bigbud-client-rpc-revision": "1",
    },
  });
  return response.text();
}
