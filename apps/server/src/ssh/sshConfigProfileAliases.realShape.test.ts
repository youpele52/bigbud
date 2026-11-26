import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSshEndpoint } from "../git/Layers/GitCore.remoteEndpoint.ts";
import { resolveProductionTargetDescriptor } from "./sshOwnerProductionTargets.ts";

/**
 * U17: a synthetic home with the directive structure and permissions of a real macOS user
 * config (world-readable `~/.ssh` and config, a top-level `~/` Include of a tool's config with a
 * proxied host, literal Host blocks with LocalForward/IdentityFile/Port, and a block with
 * UseKeychain/AddKeysToAgent). No real host, user or key is copied.
 */
const homes: string[] = [];

async function realShapedHome(extra = "", includeMode = 0o644): Promise<string> {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "bb-u17-")));
  homes.push(home);
  await mkdir(path.join(home, ".ssh"), { mode: 0o755 });
  await mkdir(path.join(home, ".tool", "ssh"), { recursive: true, mode: 0o700 });
  const tool = path.join(home, ".tool", "ssh", "config");
  await writeFile(
    tool,
    "Host toolvm\n  Hostname 127.0.0.1\n  Port 32222\n  User me\n  IdentitiesOnly yes\n" +
      "  ProxyCommand '/Applications/Tool.app/helper' proxy %h\n",
  );
  await chmod(tool, includeMode);
  for (const name of ["id_vm", "known_hosts"]) await writeFile(path.join(home, ".ssh", name), "");
  await writeFile(
    path.join(home, ".ssh", "config"),
    "Include ~/.tool/ssh/config\n\n" +
      "Host web1\n  HostName 10.9.0.1\n  User ops\n  LocalForward 8080 127.0.0.1:80\n\n" +
      `Host vm\n  HostName 10.9.0.7\n  Port 42977\n  User dev\n  IdentityFile ~/.ssh/id_vm\n${extra}\n` +
      "Host mac\n  HostName 10.9.0.8\n  User me\n  IdentityFile ~/.ssh/id_vm\n" +
      "  UseKeychain yes\n  AddKeysToAgent yes\n",
    { mode: 0o644 },
  );
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("U17 real-shaped SSH config tolerance", () => {
  it("resolves aliases and descriptors that used to be refused", async () => {
    const home = await realShapedHome("  ServerAliveInterval 30\n");
    expect(await resolveSshEndpoint({ host: "vm" }, { home })).toEqual({
      hosts: ["vm", "10.9.0.7"],
      user: "dev",
      port: 42977,
    });
    await expect(resolveProductionTargetDescriptor("ssh:mac", { home })).resolves.toMatchObject({
      host: "10.9.0.8",
      user: "me",
      port: 22,
    });
    await expect(resolveProductionTargetDescriptor("ssh:vm", { home })).resolves.toMatchObject({
      host: "10.9.0.7",
      port: 42977,
    });
  });

  it("evaluates safe Match criteria and refuses exec only where it could apply", async () => {
    const skipped = await realShapedHome('Match host 10.1.1.1 exec "true"\n  User other\n');
    expect(await resolveSshEndpoint({ host: "vm" }, { home: skipped })).toMatchObject({
      user: "dev",
    });
    const matched = await realShapedHome("Match originalhost web1 user ops\n  Port 2200\n");
    expect(await resolveSshEndpoint({ host: "web1" }, { home: matched })).toMatchObject({
      port: 2200,
    });
    const refused = await realShapedHome('Match exec "true" host 10.9.0.7\n  User other\n');
    expect(await resolveSshEndpoint({ host: "vm" }, { home: refused })).toBe("refused");
  });

  it("ignores only IgnoreUnknown-listed keywords OpenSSH does not know", async () => {
    const ignored = await realShapedHome("  IgnoreUnknown Fancy*\n  FancyThing on\n");
    expect(await resolveSshEndpoint({ host: "vm" }, { home: ignored })).not.toBe("refused");
    const known = await realShapedHome("  IgnoreUnknown Ciphers\n  Ciphers aes128-ctr\n");
    expect(await resolveSshEndpoint({ host: "vm" }, { home: known })).toBe("refused");
    // Another host's unknown keyword does not refuse this one.
    expect(await resolveSshEndpoint({ host: "web1" }, { home: known })).not.toBe("refused");
  });

  it("uses OpenSSH's default keys, in order, when a host sets no IdentityFile", async () => {
    const home = await realShapedHome();
    await expect(resolveProductionTargetDescriptor("ssh:web1", { home })).rejects.toMatchObject({
      reason: "no-identity",
    });
    // OpenSSH 10.5 order is id_rsa, id_ecdsa, id_ecdsa_sk, id_ed25519, ...; an unprotected
    // id_rsa is skipped, as OpenSSH skips it.
    await writeFile(path.join(home, ".ssh", "id_rsa"), "k", { mode: 0o644 });
    await writeFile(path.join(home, ".ssh", "id_ed25519"), "k", { mode: 0o600 });
    await writeFile(path.join(home, ".ssh", "id_ed25519_sk"), "k", { mode: 0o600 });
    await expect(resolveProductionTargetDescriptor("ssh:web1", { home })).resolves.toMatchObject({
      identityFile: path.join(home, ".ssh", "id_ed25519"),
    });
  });

  it("fails closed on an Include another account could write", async () => {
    const home = await realShapedHome("", 0o664);
    expect(await resolveSshEndpoint({ host: "vm" }, { home })).toBe("refused");
    await expect(resolveProductionTargetDescriptor("ssh:vm", { home })).rejects.toMatchObject({
      reason: "config-refused",
    });
  });
});
