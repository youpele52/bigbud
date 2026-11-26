import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SshOwnerTargetDescriptor } from "../../ssh/sshOwnerProductionClient.launch.ts";
import { endpointMatchesTarget } from "./GitCore.fetchRoute.match.ts";
import {
  endpointServesTarget,
  parseSshRemoteSpec,
  resolveSshEndpoint,
} from "./GitCore.remoteEndpoint.ts";

const homes: string[] = [];

async function home(config?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bb-endpoint-"));
  homes.push(dir);
  await mkdir(path.join(dir, ".ssh"), { mode: 0o700 });
  if (config !== undefined) await writeFile(path.join(dir, ".ssh", "config"), config);
  return dir;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const descriptor: SshOwnerTargetDescriptor = {
  targetId: "myvm",
  kind: "alias",
  host: "10.0.0.5",
  port: 42931,
  user: "bbdev",
  authMode: "key",
  identityFile: "/k",
  knownHostsFile: "/h",
};

describe("SSH remote endpoints (U15 scp/alias resolution)", () => {
  it("parses ssh:// and scp-style remotes with their paths", () => {
    expect(parseSshRemoteSpec("ssh://dev@VM.example:2222/srv/r.git")).toEqual({
      host: "vm.example",
      user: "dev",
      port: 2222,
      path: "/srv/r.git",
    });
    expect(parseSshRemoteSpec("myvm:/tmp/ws/repo.git")).toEqual({
      host: "myvm",
      path: "/tmp/ws/repo.git",
    });
    expect(parseSshRemoteSpec("git@github.com:o/r.git")).toMatchObject({ path: "o/r.git" });
    for (const bad of ["https://h/r", "/local/path", "ext::sh", "h://x", "a@b:\n"]) {
      expect(parseSshRemoteSpec(bad)).toBeUndefined();
    }
  });

  it("resolves an alias's HostName, User and Port; the remote's own user wins", async () => {
    const dir = await home(
      "Host myvm\n  HostName 10.0.0.5\n  User bbdev\n  Port 42931\nHost pat\n  HostName %h.lan\n",
    );
    const alias = await resolveSshEndpoint({ host: "myvm" }, { home: dir });
    expect(alias).toEqual({ hosts: ["myvm", "10.0.0.5"], user: "bbdev", port: 42931 });
    const other = await resolveSshEndpoint({ host: "myvm", user: "root" }, { home: dir });
    expect(other).toMatchObject({ user: "root" });
    expect(await resolveSshEndpoint({ host: "pat" }, { home: dir })).toMatchObject({
      hosts: ["pat", "pat.lan"],
    });
  });

  it("uses the literal spelling without a config and refuses a config it cannot evaluate", async () => {
    expect(await resolveSshEndpoint({ host: "h", port: 2 }, { home: await home() })).toEqual({
      hosts: ["h"],
      port: 2,
    });
    const matched = await home("Match host * exec true\n  User x\n");
    expect(await resolveSshEndpoint({ host: "h" }, { home: matched })).toBe("refused");
  });

  it("routes an alias that resolves to a target's HostName to the owner path", async () => {
    const dir = await home("Host myvm\n  HostName 10.0.0.5\n  User bbdev\n  Port 42931\n");
    const endpoint = await resolveSshEndpoint({ host: "myvm" }, { home: dir });
    if (endpoint === "refused") throw new Error("resolved");
    expect(endpointMatchesTarget(endpoint, { hosts: ["10.0.0.5"], port: 42931 })).toBe(true);
    expect(endpointMatchesTarget(endpoint, { hosts: ["10.0.0.5"], user: "other" })).toBe(false);
  });

  it("serves only the exact dialled host, user and port", () => {
    const resolved = { hosts: ["myvm", "10.0.0.5"], user: "bbdev", port: 42931 };
    expect(endpointServesTarget(resolved, "ssh:myvm", descriptor)).toBe(true);
    expect(endpointServesTarget({ ...resolved, port: 22 }, "ssh:myvm", descriptor)).toBe(false);
    // An unstated user is the local account, an unstated port is 22, as OpenSSH dials.
    expect(endpointServesTarget({ hosts: ["10.0.0.5"] }, "ssh:myvm", descriptor, "bbdev")).toBe(
      false,
    );
    expect(
      endpointServesTarget({ hosts: ["10.0.0.5"], port: 42931 }, "ssh:myvm", descriptor, "bbdev"),
    ).toBe(true);
    expect(endpointServesTarget({ ...resolved, hosts: ["other"] }, "ssh:myvm", descriptor)).toBe(
      false,
    );
  });
});

describe("bigbud target endpoints (U17)", () => {
  it("uses an alias target's config HostName and fails the set closed when it cannot", async () => {
    const { sshTargetEndpointsOf } = await import("./GitCore.fetchRoute.hosts.ts");
    const resolved = await sshTargetEndpointsOf(
      ["ssh:myvm", "ssh:host=10.0.0.9&user=dev"],
      async () => undefined,
      async () => ({ hosts: ["myvm", "10.0.0.5"], user: "bbdev", port: 42931 }),
    );
    expect(resolved).toEqual([
      { hosts: ["myvm", "10.0.0.5"], user: "bbdev", port: 42931 },
      { hosts: ["10.0.0.9"], user: "dev" },
    ]);
    // An alias whose config cannot be evaluated hides its HostName: unknown set.
    expect(
      await sshTargetEndpointsOf(
        ["ssh:myvm"],
        async () => undefined,
        async () => "refused",
      ),
    ).toBeUndefined();
  });
});
