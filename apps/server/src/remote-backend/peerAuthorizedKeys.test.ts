import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parsePeerPublicKey } from "../peer-orchestration/peerSshKey.ts";
import {
  mergePeerAuthorizedKeys,
  peerAuthorizedKeysLine,
  removePeerAuthorizedKeys,
  updateAuthorizedKeys,
} from "./peerAuthorizedKeys.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "peer-keys-"));
  dirs.push(dir);
  return dir;
}
async function keyPair(dir: string, name: string) {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", join(dir, name)]);
  return (await readFile(join(dir, `${name}.pub`), "utf8")).trim();
}

const WORKER = "c".repeat(32);
const COORDINATOR = "a".repeat(32);
const grantId = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const lineFor = (publicKey: string, n: number, coordinator = COORDINATOR) =>
  peerAuthorizedKeysLine({
    nodeBinary: "/home/u/.bigbud/graph/runtime/node",
    helperEntry: "/home/u/.bigbud/graph/server/remote-peer-relay/remoteBackendPeerRelay.mjs",
    workerAuthorityId: WORKER,
    grantId: grantId(n),
    coordinatorAuthorityId: coordinator,
    publicKey,
  });

describe("peer authorized_keys", () => {
  it("authorized_keys_line_is_restricted_and_idempotent", async () => {
    const dir = await tempDir();
    const key = await keyPair(dir, "coordinator");
    const other = await keyPair(dir, "other");
    const fingerprint = parsePeerPublicKey(key).fingerprint;
    const line = lineFor(key, 1);
    expect(line).toBe(
      `restrict,command="/home/u/.bigbud/graph/runtime/node ` +
        `/home/u/.bigbud/graph/server/remote-peer-relay/remoteBackendPeerRelay.mjs ` +
        `${WORKER} ${grantId(1)} ${COORDINATOR} ${fingerprint}" ` +
        `${key.split(" ").slice(0, 2).join(" ")} bigbud-peer:${COORDINATOR}:${grantId(1)}`,
    );
    // ssh-keygen agrees on the fingerprint the grant binds.
    const sshFingerprint = execFileSync("ssh-keygen", [
      "-E",
      "sha256",
      "-lf",
      join(dir, "coordinator.pub"),
    ])
      .toString()
      .split(" ")[1]!;
    expect(Buffer.from(sshFingerprint.slice("SHA256:".length), "base64").toString("hex")).toBe(
      fingerprint.slice("sha256:".length),
    );

    const file = join(dir, "ssh", "authorized_keys");
    const user = `${other} laptop\n`;
    await updateAuthorizedKeys(file, () => user);
    expect(
      await updateAuthorizedKeys(file, (existing) => mergePeerAuthorizedKeys(existing, line)),
    ).toBe(true);
    // Re-running the same grant changes nothing.
    expect(
      await updateAuthorizedKeys(file, (existing) => mergePeerAuthorizedKeys(existing, line)),
    ).toBe(false);
    expect(await readFile(file, "utf8")).toBe(`${user}${line}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "ssh"))).mode & 0o777).toBe(0o700);
    // Re-pairing the same coordinator replaces its line; never two lines for one coordinator/key.
    const regranted = lineFor(key, 2);
    await updateAuthorizedKeys(file, (existing) => mergePeerAuthorizedKeys(existing, regranted));
    expect(await readFile(file, "utf8")).toBe(`${user}${regranted}\n`);
    const moved = lineFor(key, 3, "e".repeat(32));
    expect(mergePeerAuthorizedKeys(`${user}${regranted}\n`, moved)).toBe(`${user}${moved}\n`);
    // A rotated coordinator key replaces the coordinator's old line too.
    const rotated = lineFor(await keyPair(dir, "rotated"), 4);
    expect(mergePeerAuthorizedKeys(`${user}${regranted}\n`, rotated)).toBe(`${user}${rotated}\n`);
    // Revoke removes only that grant's line and keeps everything else.
    await updateAuthorizedKeys(file, (existing) => removePeerAuthorizedKeys(existing, grantId(2)));
    expect(await readFile(file, "utf8")).toBe(user);
    expect(
      await updateAuthorizedKeys(file, (existing) =>
        removePeerAuthorizedKeys(existing, grantId(2)),
      ),
    ).toBe(false);
  });

  it("refuses unsafe inputs and an unrestricted line for the same key", async () => {
    const dir = await tempDir();
    const key = await keyPair(dir, "coordinator");
    expect(() => mergePeerAuthorizedKeys(`${key}\n`, lineFor(key, 1))).toThrow(
      "without the peer restriction",
    );
    for (const nodeBinary of [
      'node"; /bin/sh',
      "/usr/bin/no de",
      "relative/node",
      "/usr/bin/../../bin/sh/..",
    ])
      expect(() =>
        peerAuthorizedKeysLine({
          nodeBinary,
          helperEntry: "/srv/helper.mjs",
          workerAuthorityId: WORKER,
          grantId: grantId(1),
          coordinatorAuthorityId: COORDINATOR,
          publicKey: key,
        }),
      ).toThrow();
    for (const publicKey of [
      "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ== x",
      "ssh-ed25519 AAAA",
      `${key}\nssh-ed25519 injected`,
    ])
      expect(() => parsePeerPublicKey(publicKey)).toThrow();
    // A symlinked authorized_keys is never followed or replaced.
    const target = join(dir, "elsewhere");
    await writeFile(target, "keep\n");
    const sshDir = join(dir, "ssh");
    await updateAuthorizedKeys(join(sshDir, "authorized_keys"), () => "");
    await rm(join(sshDir, "authorized_keys"), { force: true });
    await symlink(target, join(sshDir, "authorized_keys"));
    await expect(
      updateAuthorizedKeys(join(sshDir, "authorized_keys"), (existing) =>
        mergePeerAuthorizedKeys(existing, lineFor(key, 1)),
      ),
    ).rejects.toThrow("regular file");
    expect(await readFile(target, "utf8")).toBe("keep\n");
  });
});
