import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  descriptorServesTarget,
  resolveProductionTargetDescriptor,
} from "./sshOwnerProductionTargets.ts";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** A private fake home with `~/.ssh`, optional config and the named files. */
async function home(config: string | undefined, files: ReadonlyArray<string> = []) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "bbtargets")));
  homes.push(root);
  const ssh = path.join(root, ".ssh");
  await mkdir(ssh, { mode: 0o700 });
  if (config !== undefined) {
    await writeFile(path.join(ssh, "config"), config, "utf8");
    await chmod(path.join(ssh, "config"), 0o600);
  }
  for (const file of files) await writeFile(path.join(ssh, file), "x", { mode: 0o600 });
  return root;
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a typed refusal");
    },
    (error: { readonly reason?: string }) => error.reason,
  );

describe("production SSH owner target descriptors", () => {
  it("resolves an alias target from the user's SSH config with an IP literal", async () => {
    const root = await home(
      [
        "Host build",
        "  HostName 10.0.0.5",
        "  User dev",
        "  Port 2200",
        "  IdentityFile ~/.ssh/id_build",
        "  UserKnownHostsFile ~/.ssh/known_hosts_build",
      ].join("\n"),
    );
    const descriptor = await resolveProductionTargetDescriptor("ssh:build", { home: root });
    expect(descriptor).toEqual({
      targetId: "build",
      kind: "alias",
      host: "10.0.0.5",
      port: 2200,
      user: "dev",
      authMode: "key",
      identityFile: path.join(root, ".ssh/id_build"),
      knownHostsFile: path.join(root, ".ssh/known_hosts_build"),
    });
    // The owner re-resolves alias policy by the bare alias.
    expect(descriptorServesTarget(descriptor, "ssh:build")).toBe(true);
    expect(descriptorServesTarget(descriptor, "build")).toBe(false);
  });

  it("sends an alias's files under a symlinked home in the owner's canonical form", async () => {
    const root = await home(
      [
        "Host build",
        "  HostName 10.0.0.5",
        "  User dev",
        "  IdentityFile ~/.ssh/id_build",
        `  UserKnownHostsFile ${path.join(path.sep, "unused-home", ".ssh", "known_hosts")}`,
      ].join("\n"),
    );
    // The home is reached through a link (as macOS `/tmp` and `/var` are); the
    // owner opens `~/.ssh` canonically and requires the same paths back.
    const link = `${root}-link`;
    homes.push(link);
    await symlink(root, link);
    // Out-of-scope paths are left alone; the owner refuses them itself.
    expect(await resolveProductionTargetDescriptor("ssh:build", { home: link })).toMatchObject({
      identityFile: path.join(root, ".ssh", "id_build"),
      knownHostsFile: path.join(path.sep, "unused-home", ".ssh", "known_hosts"),
    });
  });

  it("passes a DNS host name through for the owner to resolve", async () => {
    const root = await home(
      [
        "Host box",
        "  HostName box.example.internal",
        "  User dev",
        "  IdentityFile ~/.ssh/id_box",
        "  UserKnownHostsFile ~/.ssh/known_hosts",
      ].join("\n"),
    );
    const descriptor = await resolveProductionTargetDescriptor("ssh:box", { home: root });
    expect(descriptor.host).toBe("box.example.internal");
  });

  it("resolves a structured target with an explicit key and the default known-hosts file", async () => {
    const root = await home(undefined, ["known_hosts"]);
    const targetId = "ssh:host=10.0.0.9&user=ops&port=2201&keyPath=~/.ssh/id_ops";
    const descriptor = await resolveProductionTargetDescriptor(targetId, { home: root });
    expect(descriptor).toMatchObject({
      targetId,
      kind: "structured",
      host: "10.0.0.9",
      port: 2201,
      user: "ops",
      identityFile: path.join(root, ".ssh/id_ops"),
      knownHostsFile: path.join(root, ".ssh/known_hosts"),
    });
    expect(descriptorServesTarget(descriptor, targetId)).toBe(true);
  });

  it("takes a structured host name's identity from the config's Host * defaults", async () => {
    const root = await home("Host *\n  IdentityFile ~/.ssh/id_default\n", ["known_hosts"]);
    const descriptor = await resolveProductionTargetDescriptor(
      "ssh:host=box.example.internal&user=ops",
      { home: root },
    );
    expect(descriptor).toMatchObject({
      host: "box.example.internal",
      identityFile: path.join(root, ".ssh/id_default"),
    });
  });

  it("refuses when no identity can be determined", async () => {
    const root = await home(undefined, ["known_hosts"]);
    expect(
      await refusal(
        resolveProductionTargetDescriptor("ssh:host=10.0.0.9&user=ops", { home: root }),
      ),
    ).toBe("no-identity");
  });

  it("refuses password authentication before reading any config", async () => {
    const root = await home(undefined, ["known_hosts"]);
    expect(
      await refusal(
        resolveProductionTargetDescriptor("ssh:host=10.0.0.9&user=ops&auth=password", {
          home: root,
        }),
      ),
    ).toBe("password-auth");
  });

  it("refuses an agent-only alias", async () => {
    const root = await home(
      "Host agent\n  HostName 10.0.0.7\n  User dev\n  IdentityAgent ~/.ssh/agent.sock\n",
      ["known_hosts"],
    );
    expect(await refusal(resolveProductionTargetDescriptor("ssh:agent", { home: root }))).toBe(
      "agent-auth",
    );
  });

  it("refuses when neither a configured nor the default known-hosts file exists", async () => {
    const root = await home(undefined);
    expect(
      await refusal(
        resolveProductionTargetDescriptor("ssh:host=10.0.0.9&user=ops&keyPath=~/.ssh/id", {
          home: root,
        }),
      ),
    ).toBe("no-known-hosts");
  });

  it("refuses an unknown alias and a config with an unevaluated Match", async () => {
    const empty = await home("", ["known_hosts"]);
    expect(await refusal(resolveProductionTargetDescriptor("ssh:missing", { home: empty }))).toBe(
      "config-refused",
    );
    const matched = await home("Match exec true\n  User x\nHost m\n  User dev\n", ["known_hosts"]);
    expect(await refusal(resolveProductionTargetDescriptor("ssh:m", { home: matched }))).toBe(
      "config-refused",
    );
  });
});
