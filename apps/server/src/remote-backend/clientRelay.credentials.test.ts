import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { join } from "node:path";
import { readClientRelayCredentials } from "./clientRelay.credentials.ts";
import { encodeLocalSupervisorServiceConfig } from "./localSupervisorService.config.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function fixture() {
  const home = await fs.mkdtemp("/tmp/bb-crd-");
  const authorityId = "a".repeat(32);
  const configRoot = join(home, ".bigbud/backend-services", authorityId);
  const base = join(home, "base");
  const state = join(base, "userdata");
  await fs.mkdir(configRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const socketPath = join(state, "remote-backend.sock");
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });
  await fs.chmod(socketPath, 0o600);
  const tokenPath = join(configRoot, "client-token");
  await fs.writeFile(tokenPath, "private-client-value", { mode: 0o600 });
  const sha = "b".repeat(64);
  await fs.writeFile(
    join(configRoot, "config-v1"),
    encodeLocalSupervisorServiceConfig({
      version: "1",
      authority: authorityId,
      home,
      backend_home: base,
      rust_binary: join(home, "agent"),
      rust_sha256: sha,
      rust_state: join(home, "runtime"),
      node_binary: join(home, "node"),
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
  return { home, authorityId, socketPath, tokenPath };
}
it("reads only the stable authority's private token and client UDS", async () => {
  const f = await fixture();
  expect(await readClientRelayCredentials(f.home, f.authorityId)).toEqual({
    socketPath: f.socketPath,
    token: "private-client-value",
  });
  await expect(readClientRelayCredentials(f.home, "../other")).rejects.toThrow();
});
it("refuses symlink credentials and never normalizes a newline into a valid secret", async () => {
  const f = await fixture();
  await fs.writeFile(f.tokenPath, "private-client-value\n");
  await expect(readClientRelayCredentials(f.home, f.authorityId)).rejects.toThrow("credential");
  await fs.rename(f.tokenPath, f.tokenPath + ".original");
  await fs.symlink(f.tokenPath + ".original", f.tokenPath);
  await expect(readClientRelayCredentials(f.home, f.authorityId)).rejects.toThrow();
});
it("refuses a client socket with unsafe permissions before any request", async () => {
  const f = await fixture();
  await fs.chmod(f.socketPath, 0o644);
  await expect(readClientRelayCredentials(f.home, f.authorityId)).rejects.toThrow("socket");
});
