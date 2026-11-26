import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveProductionTargetDescriptor } from "./sshOwnerProductionTargets.ts";

// W2 T-alias: real-user-config style layouts for production descriptors.
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** A private home whose `~/.ssh` holds `files` (relative path → contents). */
async function home(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "bbprofile")));
  homes.push(root);
  await mkdir(path.join(root, ".ssh"), { mode: 0o700 });
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, ".ssh", name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, contents, "utf8");
    await chmod(file, 0o600);
  }
  return root;
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a typed refusal");
    },
    (error: { readonly reason?: string }) => error.reason,
  );

const KEYS = { "keys/work_ed25519": "k", id_ed25519: "k", known_hosts: "" };

describe("production descriptors from a real-user-style ~/.ssh/config", () => {
  it("resolves aliases declared in an ordered relative Include with Host * defaults", async () => {
    const root = await home({
      ...KEYS,
      config: [
        "# personal defaults",
        "Include config.d/*.conf",
        "",
        "Host *",
        "  IdentitiesOnly yes",
        "  IdentityFile ~/.ssh/id_ed25519",
        "  ServerAliveInterval 30",
        "",
      ].join("\n"),
      "config.d/10-work.conf": [
        "Host work-box work",
        "  HostName 10.20.0.7",
        "  User deploy",
        "  IdentityFile ~/.ssh/keys/work_ed25519",
        "",
      ].join("\n"),
    });
    for (const alias of ["work-box", "work"]) {
      const descriptor = await resolveProductionTargetDescriptor(`ssh:${alias}`, { home: root });
      expect(descriptor).toMatchObject({
        targetId: alias,
        kind: "alias",
        host: "10.20.0.7",
        // No Port line: the OpenSSH default.
        port: 22,
        user: "deploy",
        // First value wins: the included stanza precedes `Host *`.
        identityFile: path.join(root, ".ssh/keys/work_ed25519"),
        knownHostsFile: path.join(root, ".ssh/known_hosts"),
      });
    }
  });

  it("takes an explicit port 22 and an IPv6 HostName literal", async () => {
    const root = await home({
      ...KEYS,
      config: [
        "Host v6",
        "  HostName ::1",
        "  Port 22",
        "  User dev",
        "  IdentityFile ~/.ssh/id_ed25519",
        "",
      ].join("\n"),
    });
    expect(await resolveProductionTargetDescriptor("ssh:v6", { home: root })).toMatchObject({
      host: "::1",
      port: 22,
      user: "dev",
    });
  });

  it("refuses a Match block even when it only appears in an included file", async () => {
    const root = await home({
      ...KEYS,
      config: "Include config.d/*.conf\nHost plain\n  HostName 10.0.0.9\n  User dev\n",
      // U17: exec first, so the block could apply to any host and must refuse.
      "config.d/50-match.conf": "Match exec true host *.corp\n  User other\n",
    });
    expect(await refusal(resolveProductionTargetDescriptor("ssh:plain", { home: root }))).toBe(
      "config-refused",
    );
  });

  it("refuses an alias that only authenticates through an agent", async () => {
    const root = await home({
      known_hosts: "",
      config:
        "Host agent-only\n  HostName 10.0.0.3\n  User dev\n  IdentityAgent ~/.1password/agent.sock\n",
    });
    expect(await refusal(resolveProductionTargetDescriptor("ssh:agent-only", { home: root }))).toBe(
      "agent-auth",
    );
  });
});
