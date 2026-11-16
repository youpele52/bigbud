import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  expectedLocalSupervisorAuthority,
  encodeLocalSupervisorAuthority,
} from "./localSupervisorAuthority.record.ts";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLocalSupervisorAuthorityReservation as assertReservation,
  claimLocalSupervisorAuthorityReservation as claim,
} from "./localSupervisorAuthority.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import type { LocalSupervisorAuthorityIdentity } from "./localSupervisorAuthority.record.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await fs.rm(path, { recursive: true, force: true });
});
function identity(
  authority = "a".repeat(32),
  installation = "c".repeat(64),
): LocalSupervisorAuthorityIdentity {
  return {
    authority: { authorityId: authority, keyEpoch: 1, keyFingerprint: `sha256:${"b".repeat(64)}` },
    installationFingerprint: `sha256:${installation}`,
  };
}
async function fixture(owner = identity()) {
  const home = await fs.realpath(await fs.mkdtemp("/tmp/bb-sauth-"));
  roots.push(home);
  const control = makeLocalSupervisorControl({
    homeDir: home,
    targetId: `remote-backend:${owner.authority.authorityId}`,
  });
  const backendHome = join(home, "backend");
  const backendStateDir = join(backendHome, "state");
  await fs.mkdir(backendStateDir, { recursive: true, mode: 0o700 });
  return {
    home,
    control,
    owner,
    backendHome,
    backendStateDir,
    consent: { confirmFreshSetup: true, backendHome, backendStateDir } as const,
    path: join(control.root, "account-authority-v1"),
  };
}

describe("private account-root backend authority reservation", () => {
  it("matches the native golden root fingerprint and exact reservation bytes", () => {
    const record = expectedLocalSupervisorAuthority(
      "/home/test/.bigbud/agent",
      { uid: 1000n, dev: 2049n, ino: 42n },
      identity(),
      {
        backend_home: "/srv/bigbud",
        backend_home_dev: "2049",
        backend_home_ino: "40",
        backend_state: "/srv/bigbud/state",
        backend_state_dev: "2049",
        backend_state_ino: "41",
      },
    );
    expect(record.agent_root).toBe(
      "sha256:a8c81dbbd62f73822a5026e0ebfe6c2d9ec76a6f7960595d7209829deb8f789d",
    );
    expect(createHash("sha256").update(encodeLocalSupervisorAuthority(record)).digest("hex")).toBe(
      "436bbb6236cd5bee994ffedd2d2cb3ab75d42603cfbe481c4b526615b045d5fd",
    );
  });
  it("read/adoption never creates missing account state", async () => {
    const f = await fixture();
    await expect(assertReservation(f.control, f.owner)).rejects.toThrow();
    await expect(fs.lstat(join(f.home, ".bigbud"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("explicit fresh claim is stable across key/process epochs and idempotent concurrent first calls", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 8 }, () => claim(f.control, f.owner, f.consent)));
    await assertReservation(f.control, {
      ...f.owner,
      authority: { ...f.owner.authority, keyEpoch: 17, keyFingerprint: `sha256:${"d".repeat(64)}` },
    });
    const stat = await fs.lstat(f.path);
    expect(stat.mode & 0o7777).toBe(0o600);
    expect(stat.nlink).toBe(1);
    expect(await fs.readdir(f.control.root)).toEqual(["account-authority-v1"]);
  });
  it("allows exactly one authority to win concurrent foreign first claims", async () => {
    const f = await fixture();
    const other = identity("b".repeat(32));
    const foreign = makeLocalSupervisorControl({
      homeDir: f.home,
      targetId: `remote-backend:${other.authority.authorityId}`,
    });
    const results = await Promise.allSettled([
      claim(f.control, f.owner, f.consent),
      claim(foreign, other, f.consent),
    ]);
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    const winner =
      results[0]!.status === "fulfilled"
        ? ([f.control, f.owner] as const)
        : ([foreign, other] as const);
    await assertReservation(...winner);
  });
  it("refuses nonempty legacy account state and never replaces it", async () => {
    const f = await fixture();
    await fs.mkdir(f.control.root, { recursive: true, mode: 0o700 });
    const legacy = join(f.control.root, "legacy");
    await fs.writeFile(legacy, "preserve", { mode: 0o600 });
    await expect(claim(f.control, f.owner, f.consent)).rejects.toThrow();
    expect(await fs.readFile(legacy, "utf8")).toBe("preserve");
    await expect(fs.lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["readonly", "symlink", "install-mismatch", "malformed", "hardlink"] as const)(
    "rejects %s reservation without auto-repair",
    async (change) => {
      const f = await fixture();
      await claim(f.control, f.owner, f.consent);
      const original = await fs.readFile(f.path, "utf8");
      if (change === "readonly") await fs.chmod(f.path, 0o400);
      if (change === "symlink") {
        await fs.rename(f.path, `${f.path}.saved`);
        await fs.symlink(`${f.path}.saved`, f.path);
      }
      if (change === "malformed") await fs.writeFile(f.path, original + "version=1\n");
      if (change === "hardlink") await fs.link(f.path, `${f.path}.alias`);
      const owner =
        change === "install-mismatch" ? identity("a".repeat(32), "e".repeat(64)) : f.owner;
      await expect(assertReservation(f.control, owner)).rejects.toThrow();
      await expect(claim(f.control, owner, f.consent)).rejects.toThrow();
      if (change !== "malformed") expect(await fs.readFile(f.path, "utf8")).toBe(original);
    },
  );
  it("rejects a copied private agent root without regenerating its reservation", async () => {
    const source = await fixture();
    await claim(source.control, source.owner, source.consent);
    const copied = await fixture();
    await fs.mkdir(join(copied.home, ".bigbud"), { mode: 0o700 });
    await fs.cp(source.control.root, copied.control.root, { recursive: true });
    const original = await fs.readFile(copied.path, "utf8");
    await expect(assertReservation(copied.control, copied.owner)).rejects.toThrow("copied root");
    await expect(claim(copied.control, copied.owner, copied.consent)).rejects.toThrow();
    expect(await fs.readFile(copied.path, "utf8")).toBe(original);
  });
  it("rejects symlinked roots and missing consent before changing existing data", async () => {
    const f = await fixture();
    await expect(claim(f.control, f.owner, { confirmFreshSetup: false } as never)).rejects.toThrow(
      "consent",
    );
    await expect(fs.lstat(join(f.home, ".bigbud"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir(join(f.home, ".bigbud"), { mode: 0o700 });
    const other = join(f.home, "other");
    await fs.mkdir(other, { mode: 0o700 });
    await fs.symlink(other, f.control.root);
    await expect(claim(f.control, f.owner, f.consent)).rejects.toThrow();
    expect(await fs.readdir(other)).toEqual([]);
  });
  it.each(["state", "base"] as const)(
    "refuses replaced backend %s tuple without rewriting ownership",
    async (which) => {
      const f = await fixture();
      await claim(f.control, f.owner, f.consent);
      const original = await fs.readFile(f.path, "utf8");
      const path = which === "state" ? f.backendStateDir : f.backendHome;
      await fs.rename(path, `${path}.previous`);
      await fs.mkdir(f.backendStateDir, { recursive: true, mode: 0o700 });
      await expect(assertReservation(f.control, f.owner)).rejects.toThrow();
      await expect(claim(f.control, f.owner, f.consent)).rejects.toThrow();
      expect(await fs.readFile(f.path, "utf8")).toBe(original);
    },
  );
  it("refuses state outside the private backend base before creating the account root", async () => {
    const f = await fixture();
    await expect(
      claim(f.control, f.owner, { ...f.consent, backendStateDir: f.home }),
    ).rejects.toThrow("beneath");
    await expect(fs.lstat(f.control.root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
