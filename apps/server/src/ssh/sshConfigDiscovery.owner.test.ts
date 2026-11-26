import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverSshConfigHosts,
  sshConfigHostFromOwnerAlias,
  sshConfigHostsFromOwnerAliases,
} from "./sshConfigDiscovery.ts";
import {
  formatProfileAliasRefusal,
  resolveProfileAliases,
  type SshConfigProfileResolution,
} from "./sshConfigProfileAliases.ts";

let root: string;
let source: string;

async function write(name: string, content: string): Promise<void> {
  const location = path.join(root, name);
  await mkdir(path.dirname(location), { recursive: true });
  await writeFile(location, content, { mode: 0o600 });
}

async function resolve(content?: string): Promise<SshConfigProfileResolution> {
  return resolveProfileAliases({
    root,
    sourcePath: source,
    content: content ?? (await readFile(source, "utf8")),
  });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bigbud-profile-aliases-")));
  source = path.join(root, "ssh-config");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveProfileAliases", () => {
  it("matches the legacy discovery parser on the same real-shaped fixture", async () => {
    await write(
      "ssh-config",
      [
        "# Real-shaped work config",
        "Host *",
        "  ConnectTimeout 4",
        "Host !prod-* build-box",
        "  HostName build.internal",
        "  User ci",
        "  Port 2222",
        "Include hosts.d/*.conf",
        "Host gpu-box",
        "  HostKeyAlias gpu-trust",
        "",
      ].join("\n"),
    );
    await write("hosts.d/10-lab.conf", "Host lab-a\n  HostName lab-a.internal\n");
    await write("hosts.d/20-lab.conf", "Host lab-b\n");
    const content = await readFile(source, "utf8");

    const resolved = await resolveProfileAliases({ root, sourcePath: source, content });
    const legacy = await discoverSshConfigHosts({
      roots: [{ kind: "user", path: source, includeBaseDir: root }],
      homeDir: root,
      machineName: "profile",
    });

    expect(resolved.hints.map((hint) => hint.alias)).toEqual(
      legacy.hosts.map((host) => host.alias),
    );
    expect(resolved.hints.map((hint) => hint.alias)).toEqual([
      "build-box",
      "lab-a",
      "lab-b",
      "gpu-box",
    ]);
    expect(resolved.refusals).toEqual([]);
  });

  it("applies wildcard defaults, negation and first-value-wins per alias", async () => {
    await write(
      "ssh-config",
      [
        "Host build-box",
        "  HostName build.internal",
        "  Port 2200",
        "Host prod-web",
        "  HostName prod.internal",
        "Host !prod-* *",
        "  HostName fallback.internal",
        "  User default-user",
        "Host *",
        "  User default-user",
        "  Port 22",
        "",
      ].join("\n"),
    );

    const resolved = await resolve();

    expect(resolved.hints).toEqual([
      expect.objectContaining({
        alias: "build-box",
        hostName: "build.internal",
        user: "default-user",
        port: "2200",
        route: "direct",
      }),
      expect.objectContaining({
        alias: "prod-web",
        hostName: "prod.internal",
        user: "default-user",
        port: "22",
      }),
    ]);
    // `!prod-*` removes prod-web from the fallback block but the alias itself stays concrete.
    expect(resolved.hints[1]?.hostName).toBe("prod.internal");
  });

  it("follows ordered includes in place and reports the declaring source", async () => {
    await write("ssh-config", "Include hosts.d/*.conf\nHost after\n  HostName after.internal\n");
    await write("hosts.d/a.conf", "Host from-a\n  HostName a.internal\n");
    await write("hosts.d/b.conf", "Host from-b\n  HostName b.internal\n");

    const resolved = await resolve();

    expect(resolved.hints.map((hint) => hint.alias)).toEqual(["from-a", "from-b", "after"]);
    expect(resolved.hints[0]).toMatchObject({
      source: "user_include",
      sourcePath: path.join(root, "hosts.d", "a.conf"),
      line: 1,
      hostName: "a.internal",
    });
    expect(resolved.hints[2]?.source).toBe("user_config");
  });

  it("keeps HostKeyAlias and an IPv6 destination without exposing identity paths", async () => {
    await write(
      "ssh-config",
      [
        "Host v6-box",
        "  HostName ::1",
        "  User picker",
        "  Port 22222",
        "  HostKeyAlias v6-trust",
        "  IdentityFile /Users/someone/.ssh/id_ed25519",
        "",
      ].join("\n"),
    );

    const resolved = await resolve();

    expect(resolved.hints).toEqual([
      {
        alias: "v6-box",
        sourcePath: source,
        source: "user_config",
        line: 1,
        hostName: "::1",
        user: "picker",
        port: "22222",
        hostKeyAlias: "v6-trust",
        route: "direct",
      },
    ]);
    expect(JSON.stringify(resolved.hints)).not.toContain("id_ed25519");
  });

  it("defaults to port 22 and accepts an explicit port 22", async () => {
    await write(
      "ssh-config",
      ["Host implicit", "  HostName implicit.internal", "Host explicit", "  Port 22", ""].join(
        "\n",
      ),
    );

    const resolved = await resolve();

    expect(resolved.hints.map((hint) => hint.port)).toEqual(["22", "22"]);
  });

  it("refuses Match exec and unsupported directives with located, value-free diagnostics", async () => {
    const marker = path.join(root, "executed");
    await write(
      "ssh-config",
      [
        'Match exec "touch executed"',
        "  User never",
        "Host safe",
        "  HostName safe.internal",
        "  LocalCommand touch executed",
        "  BogusDirective secret-value",
        "",
      ].join("\n"),
    );
    const before = await readFile(source, "utf8");

    const resolved = await resolve();

    expect(resolved.refusals).toEqual([
      expect.objectContaining({ directive: "Match", source: "user_config", line: 1 }),
      expect.objectContaining({ directive: "LocalCommand", source: "user_config", line: 5 }),
      expect.objectContaining({ directive: "bogusdirective", source: "user_config", line: 6 }),
    ]);
    const messages = resolved.refusals.map(formatProfileAliasRefusal).join("\n");
    expect(messages).toContain("Match in user config at line 1");
    expect(messages).toContain("LocalCommand in user config at line 5");
    expect(messages).not.toContain("secret-value");
    expect(await readFile(source, "utf8")).toBe(before);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps orphaned wildcard-only configs without aliases empty", async () => {
    await write("ssh-config", "Host *\n  User only-defaults\n");

    const resolved = await resolve();

    expect(resolved.hints).toEqual([]);
    expect(resolved.refusals).toEqual([]);
  });
});

describe("selected owner discovery", () => {
  it("maps the owner list, preserves order and reports per-alias unsupported entries", () => {
    const result = sshConfigHostsFromOwnerAliases(
      {
        entries: [
          {
            alias: "build-box",
            hostName: "build.internal",
            port: 2222,
            user: "ci",
            hostKeyAlias: "build-trust",
            routeKind: "direct",
            jumpHops: 0,
            source: "user_config",
            line: 5,
          },
          {
            alias: "blocked",
            hostName: "blocked.internal",
            port: 22,
            user: "",
            hostKeyAlias: "",
            routeKind: "jump",
            jumpHops: 1,
            source: "user_config",
            line: 9,
            unsupported: {
              reason: "localcommand",
              remedy: "Remove the unsupported directive from this host.",
              source: "user_config",
              line: 9,
            },
          },
        ],
        truncated: false,
        maxEntries: 256,
      },
      "/profile/ssh-config",
      "profile",
    );

    expect(result.hosts.map((host) => host.alias)).toEqual(["build-box", "blocked"]);
    expect(result.hosts[0]).toMatchObject({
      hostName: "build.internal",
      user: "ci",
      port: "2222",
      hostKeyAlias: "build-trust",
      route: "direct",
      supported: true,
    });
    expect(result.hosts[1]).toMatchObject({
      route: "via 1 hop",
      supported: false,
      unsupportedReason: "Remove the unsupported directive from this host.",
    });
    expect(
      sshConfigHostFromOwnerAlias(
        {
          alias: "v6-box",
          hostName: "::1",
          port: 22,
          user: "",
          hostKeyAlias: "",
          routeKind: "restrictedConnector",
          jumpHops: 0,
          source: "user_config",
          line: 1,
        },
        "/profile/ssh-config",
      ).route,
    ).toBe("restricted connector");
  });

  it("leaves the non-selected legacy discovery path unchanged", async () => {
    await write("ssh-config", "Host legacy\n  HostName legacy.internal\n  Port 2200\n");
    const legacy = await discoverSshConfigHosts({
      roots: [{ kind: "user", path: source, includeBaseDir: root }],
      homeDir: root,
      machineName: "profile",
    });
    expect(legacy.hosts).toEqual([
      {
        alias: "legacy",
        sourcePath: "~/ssh-config",
        line: 1,
        hostName: "legacy.internal",
        port: "2200",
      },
    ]);
    expect(legacy.hosts[0]).not.toHaveProperty("supported");
  });
});
