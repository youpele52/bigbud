import * as fs from "node:fs/promises";
import * as http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import { makeRemoteBackendRelayLeases } from "./clientRelay.leases.ts";
import { openRemoteBackendRelayProfileOwner } from "./clientRelay.profileOwner.ts";
import type { ResolvedRemoteBackendRelayProfile } from "./clientRelay.profiles.ts";
import { encodeLocalSupervisorServiceConfig } from "./localSupervisorService.config.ts";
import type { ClientRelayOwnerExit, ClientRelaySshOwner } from "./clientRelay.ssh.owner.ts";
export interface RelayFixtureCalls {
  children: ChildProcess[];
  args: string[];
}
/**
 * Fixture SSH owner. SSH is Rust-owner-only (W7), so the relay transport is supplied through the
 * owner seam. It runs the real relay entry as a real child process (recorded by the test's
 * `node:child_process` spawn mock) and confirms exit only on that child's reap.
 */
export function makeFixtureRelaySshOwner(calls: RelayFixtureCalls): ClientRelaySshOwner {
  return {
    openClientRelay: async (_request, signal) => {
      signal.throwIfAborted();
      const child = spawn(process.execPath, calls.args, { stdio: ["pipe", "pipe", "ignore"] });
      const exit = new Promise<ClientRelayOwnerExit>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, exitSignal) =>
          resolve(
            exitSignal
              ? { kind: "signaled", signal: exitSignal }
              : { kind: "exited", code: code ?? 0 },
          ),
        );
      });
      return {
        stream: Duplex.from({ readable: child.stdout, writable: child.stdin }),
        exit,
        cancel: () => {
          child.kill("SIGTERM");
        },
      };
    },
  };
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
  // The pinned remote helper path is never executed here: the fixture SSH owner runs the real
  // relay entry against this fixture's HOME, private token and backend socket.
  const helper = "/fixture-helper/remoteBackendClientRelay.mjs";
  calls.args = [
    "--experimental-transform-types",
    fileURLToPath(new URL("./clientRelay.entry.ts", import.meta.url)),
    authorityId,
  ];
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
  const sshOwner = makeFixtureRelaySshOwner(calls);
  const leases = makeRemoteBackendRelayLeases({
    profiles: {
      list: async () => ({ availability: "available", profiles: [profile.profile] }),
      resolve: async () => profile,
    },
    isCallerActive: async (caller) => active.has(caller),
    openProfile: (selected, signal) =>
      openRemoteBackendRelayProfileOwner(selected, [], signal, sshOwner),
  });
  cleanup.push(async () => {
    await leases.dispose();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });
  return { leases, active, profile, sshOwner };
}
export async function fetchLease(lease: { baseUrl: string; localCredential: string }) {
  const response = await fetch(lease.baseUrl + "/asset", {
    headers: {
      authorization: `Bearer ${lease.localCredential}`,
      "x-bigbud-client-rpc-revision": "1",
    },
  });
  if (!response.ok) throw new Error(`Fixture relay returned HTTP ${response.status}`);
  return response.text();
}
