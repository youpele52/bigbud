import { execFileSync } from "node:child_process";
import { constants, openSync, closeSync } from "node:fs";
import { generateKeyPairSync, verify } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadRemoteBackendIdentity } from "./authority.ts";
import { AUTHORITY_FILENAME, ensurePrivateRemoteStateRoot } from "./authority.files.ts";

let root: string;
const owner = (stateDir = root) => ({
  stateDir,
  machineId: "machine-v1:fixture",
  nonce: "held-backend-acquisition",
  assertHeld: async () => {},
});
const identityPath = () => join(root, AUTHORITY_FILENAME);

beforeEach(async () => {
  root = await fs.mkdtemp(join(os.tmpdir(), "bigbud-remote-authority-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform !== "win32")("remote backend authority persistence", () => {
  it("persists one private identity across restart and signs only domain-separated challenges", async () => {
    const first = await loadRemoteBackendIdentity(owner());
    const restarted = await loadRemoteBackendIdentity({ ...owner(), nonce: "next-acquisition" });
    expect(restarted.authority).toEqual(first.authority);
    expect(restarted.installationFingerprint).toBe(first.installationFingerprint);
    expect((await fs.stat(identityPath())).mode & 0o7777).toBe(0o600);
    expect(first.authority.authorityId).toMatch(/^[0-9a-f]{32}$/);
    const challenge = Buffer.from("fixture challenge");
    const signature = restarted.signChallenge(challenge);
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from("bigbud.remote-backend.challenge.v1\0"), challenge]),
        first.publicKey,
        signature,
      ),
    ).toBe(true);
    expect(verify(null, challenge, first.publicKey, signature)).toBe(false);
    expect(() => restarted.signChallenge(new Uint8Array(4097))).toThrow("size");
    expect(() => restarted.signChallenge(new Uint8Array())).toThrow("size");
    expect(JSON.stringify(first)).not.toContain("PRIVATE KEY");
    expect(Object.isFrozen(first.authority)).toBe(true);
  });

  it("coalesces concurrent first initialization under the same held backend acquisition", async () => {
    const identities = await Promise.all(
      Array.from({ length: 20 }, () => loadRemoteBackendIdentity(owner())),
    );
    expect(new Set(identities.map((identity) => identity.authority.authorityId)).size).toBe(1);
    expect(await fs.readdir(root)).toEqual([AUTHORITY_FILENAME]);
  });

  it("projects only public authority fields from an existing private record", async () => {
    const first = await loadRemoteBackendIdentity(owner());
    const record = JSON.parse(await fs.readFile(identityPath(), "utf8"));
    record.authority.privateKey = "fixture-private-sentinel";
    record.authority.token = "fixture-token-sentinel";
    await fs.writeFile(identityPath(), JSON.stringify(record));
    const next = await loadRemoteBackendIdentity(owner());
    expect(next.authority).toEqual(first.authority);
    expect(Object.keys(next.authority).toSorted()).toEqual([
      "authorityId",
      "keyEpoch",
      "keyFingerprint",
    ]);
    expect(JSON.stringify(next)).not.toContain("fixture-private-sentinel");
    expect(JSON.stringify(next)).not.toContain("fixture-token-sentinel");
  });

  it("refuses copied state without replacing the copied key", async () => {
    await loadRemoteBackendIdentity(owner());
    const copy = await fs.mkdtemp(join(os.tmpdir(), "bigbud-remote-authority-copy-"));
    try {
      await fs.cp(root, copy, { recursive: true });
      const before = await fs.readFile(join(copy, AUTHORITY_FILENAME));
      await expect(loadRemoteBackendIdentity(owner(copy))).rejects.toMatchObject({
        code: "installation-changed",
      });
      expect(await fs.readFile(join(copy, AUTHORITY_FILENAME))).toEqual(before);
    } finally {
      await fs.rm(copy, { recursive: true, force: true });
    }
  });

  it("refuses a different machine identity and leaves the existing authority intact", async () => {
    await loadRemoteBackendIdentity(owner());
    const before = await fs.readFile(identityPath());
    await expect(
      loadRemoteBackendIdentity({ ...owner(), machineId: "machine-v1:other" }),
    ).rejects.toMatchObject({ code: "installation-changed" });
    expect(await fs.readFile(identityPath())).toEqual(before);
  });

  it("requires a stable machine identity", async () => {
    await expect(loadRemoteBackendIdentity({ ...owner(), machineId: null })).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(["broken JSON", "null", "{}"])(
    "never regenerates over invalid existing identity: %s",
    async (raw) => {
      await fs.writeFile(identityPath(), raw, { mode: 0o600 });
      await expect(loadRemoteBackendIdentity(owner())).rejects.toMatchObject({
        code: "invalid-identity",
      });
      expect(await fs.readFile(identityPath(), "utf8")).toBe(raw);
    },
  );

  it("rejects a key/fingerprint conflict without disclosing its private material", async () => {
    await loadRemoteBackendIdentity(owner());
    const record = JSON.parse(await fs.readFile(identityPath(), "utf8"));
    record.privateKey = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    await fs.writeFile(identityPath(), JSON.stringify(record));
    await expect(loadRemoteBackendIdentity(owner())).rejects.toMatchObject({
      code: "invalid-identity",
    });
    await expect(loadRemoteBackendIdentity(owner())).rejects.not.toThrow("PRIVATE KEY");
  });

  it("refuses nonprivate files and oversized records", async () => {
    await loadRemoteBackendIdentity(owner());
    await fs.chmod(identityPath(), 0o644);
    await expect(loadRemoteBackendIdentity(owner())).rejects.toMatchObject({
      code: "unsafe-state",
    });
    await fs.chmod(identityPath(), 0o600);
    await fs.writeFile(identityPath(), "x".repeat(16 * 1024 + 1));
    await expect(loadRemoteBackendIdentity(owner())).rejects.toMatchObject({
      code: "unsafe-state",
    });
  });

  it.each(["symlink", "hardlink"])("refuses a %s identity", async (kind) => {
    await loadRemoteBackendIdentity(owner());
    const saved = join(root, "saved");
    await fs.rename(identityPath(), saved);
    if (kind === "symlink") await fs.symlink(saved, identityPath());
    else await fs.link(saved, identityPath());
    const before = await fs.readFile(saved);
    await expect(loadRemoteBackendIdentity(owner())).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect(await fs.readFile(saved)).toEqual(before);
  });

  it("refuses nonprivate state roots rather than silently changing existing permissions", async () => {
    await fs.chmod(root, 0o755);
    await expect(loadRemoteBackendIdentity(owner())).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect((await fs.stat(root)).mode & 0o7777).toBe(0o755);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a symlink state root", async () => {
    const alias = join(root, "alias");
    const directory = join(root, "real");
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.symlink(directory, alias);
    await expect(ensurePrivateRemoteStateRoot(alias)).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("checks the backend lock before publication and cleans its unpublished private temporary", async () => {
    let checks = 0;
    const changed = {
      ...owner(),
      assertHeld: async () => {
        if (++checks > 1) throw new Error("owner lost");
      },
    };
    await expect(loadRemoteBackendIdentity(changed)).rejects.toThrow("owner lost");
    expect(await fs.readdir(root)).toEqual([]);
  });
  it.each(["authorityId", "installationFingerprint"])(
    "rejects array-coerced %s fields",
    async (field) => {
      await loadRemoteBackendIdentity(owner());
      const record = JSON.parse(await fs.readFile(identityPath(), "utf8"));
      if (field === "authorityId") record.authority.authorityId = [record.authority.authorityId];
      else record.installationFingerprint = [record.installationFingerprint];
      const malformed = JSON.stringify(record);
      await fs.writeFile(identityPath(), malformed);
      await expect(loadRemoteBackendIdentity(owner())).rejects.toMatchObject({
        code: "invalid-identity",
      });
      expect(await fs.readFile(identityPath(), "utf8")).toBe(malformed);
    },
  );

  it("rejects a FIFO identity without waiting for a writer", async () => {
    execFileSync("mkfifo", [identityPath()]);
    await fs.chmod(identityPath(), 0o600);
    let rescued = false;
    let rescueError: unknown;
    // Wake a broken blocking reader so the RED regression cannot strand a libuv worker.
    const rescue = setTimeout(() => {
      rescued = true;
      try {
        const descriptor = openSync(identityPath(), constants.O_WRONLY | constants.O_NONBLOCK);
        closeSync(descriptor);
      } catch (cause) {
        rescueError = cause;
      }
    }, 1000);
    try {
      await expect(loadRemoteBackendIdentity(owner())).rejects.toMatchObject({
        code: "unsafe-state",
      });
      expect(rescueError).toBeUndefined();
      expect(rescued).toBe(false);
    } finally {
      clearTimeout(rescue);
    }
  });

  it("preserves both links of an interrupted first publication and requires explicit repair", async () => {
    await loadRemoteBackendIdentity(owner());
    const temporary = join(root, ".remote-authority-interrupted.tmp");
    await fs.rename(identityPath(), temporary);
    await fs.link(temporary, identityPath());
    const contents = await fs.readFile(temporary);
    await expect(loadRemoteBackendIdentity(owner())).rejects.toThrow("Preserve");
    expect(await fs.readFile(temporary)).toEqual(contents);
    expect(await fs.readFile(identityPath())).toEqual(contents);
    expect((await fs.stat(identityPath())).nlink).toBe(2);
    expect((await fs.readdir(root)).toSorted()).toEqual(
      [".remote-authority-interrupted.tmp", AUTHORITY_FILENAME].toSorted(),
    );
  });
});
