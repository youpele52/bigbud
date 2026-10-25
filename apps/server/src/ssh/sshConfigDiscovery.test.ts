import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverSshConfigHosts,
  SSH_CONFIG_MAX_FILE_BYTES,
  SSH_CONFIG_MAX_FILES,
  SSH_CONFIG_MAX_INCLUDE_DEPTH,
} from "./sshConfigDiscovery.ts";
import type { SshConfigRoot } from "./sshConfigSources.ts";

let tempDir: string;
let homeDir: string;
let userDir: string;
let systemDir: string;

function roots(): ReadonlyArray<SshConfigRoot> {
  return [
    { kind: "user", path: path.join(userDir, "config"), includeBaseDir: userDir },
    { kind: "system", path: path.join(systemDir, "ssh_config"), includeBaseDir: systemDir },
  ];
}

async function write(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function discover() {
  return discoverSshConfigHosts({ roots: roots(), homeDir, machineName: "test-machine" });
}

beforeEach(async () => {
  tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bigbud-ssh-config-")));
  homeDir = path.join(tempDir, "home");
  userDir = path.join(homeDir, ".ssh");
  systemDir = path.join(tempDir, "etc-ssh");
  await fs.mkdir(userDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("discoverSshConfigHosts", () => {
  it("follows relative and globbed includes in order and reports a missing system file", async () => {
    await write(
      path.join(userDir, "config"),
      ["Host first", "  HostName 10.0.0.1", "Include config.d/*", "Host last"].join("\n"),
    );
    await write(path.join(userDir, "config.d", "b.conf"), "Host from-b\n");
    await write(path.join(userDir, "config.d", "a.conf"), "Host from-a\nHost first\n");
    await write(path.join(userDir, "config.d", ".hidden"), "Host hidden\n");

    const result = await discover();

    expect(result.machineName).toBe("test-machine");
    expect(result.hosts.map((host) => host.alias)).toEqual(["first", "from-a", "from-b", "last"]);
    expect(result.hosts[0]).toEqual({
      alias: "first",
      sourcePath: "~/.ssh/config",
      line: 1,
      hostName: "10.0.0.1",
    });
    expect(result.hosts[1]?.sourcePath).toBe("~/.ssh/config.d/a.conf");
    expect(result.sources).toContainEqual({
      path: path.join(systemDir, "ssh_config"),
      kind: "system",
      status: "missing",
    });
  });

  it("resolves system includes against the system directory", async () => {
    await write(path.join(systemDir, "ssh_config"), "Include ssh_config.d/*.conf\n");
    await write(path.join(systemDir, "ssh_config.d", "corp.conf"), "Host corp-jump\n");

    const result = await discover();

    expect(result.hosts.map((host) => host.alias)).toEqual(["corp-jump"]);
  });

  it("stops include cycles and skips token includes", async () => {
    await write(
      path.join(userDir, "config"),
      ["Include loop.conf", "Include ~/.ssh/%h.conf", "Host home"].join("\n"),
    );
    await write(path.join(userDir, "loop.conf"), "Include config\nHost looped\n");

    const result = await discover();

    expect(result.hosts.map((host) => host.alias)).toEqual(["looped", "home"]);
    expect(result.sources.filter((source) => source.status === "skipped")).toHaveLength(2);
  });

  it("reports oversized files without reading their hosts", async () => {
    await write(
      path.join(userDir, "config"),
      `Host big\n#${"x".repeat(SSH_CONFIG_MAX_FILE_BYTES)}\n`,
    );

    const result = await discover();

    expect(result.hosts).toEqual([]);
    expect(result.sources[0]).toMatchObject({ kind: "user", status: "error" });
  });

  it("stops following includes past the nesting limit", async () => {
    await write(path.join(userDir, "config"), "Include chain-1.conf\n");
    for (let depth = 1; depth <= SSH_CONFIG_MAX_INCLUDE_DEPTH + 2; depth += 1) {
      await write(
        path.join(userDir, `chain-${depth}.conf`),
        `Host level-${depth}\nInclude chain-${depth + 1}.conf\n`,
      );
    }

    const result = await discover();

    expect(result.hosts).toHaveLength(SSH_CONFIG_MAX_INCLUDE_DEPTH);
    expect(result.sources).toContainEqual(
      expect.objectContaining({ status: "skipped", message: expect.stringMatching(/too deep/u) }),
    );
  });

  it("stops reading files at the file limit", async () => {
    await write(path.join(userDir, "config"), "Include many/*\n");
    for (let index = 0; index < SSH_CONFIG_MAX_FILES + 5; index += 1) {
      const name = String(index).padStart(3, "0");
      await write(path.join(userDir, "many", `${name}.conf`), `Host host-${name}\n`);
    }

    const result = await discover();

    expect(result.hosts).toHaveLength(SSH_CONFIG_MAX_FILES - 1);
    expect(result.sources).toContainEqual(
      expect.objectContaining({ status: "skipped", message: "SSH config file limit reached." }),
    );
  });

  it("returns no hosts when no config exists", async () => {
    const result = await discover();

    expect(result.hosts).toEqual([]);
    expect(result.sources.map((source) => source.status)).toEqual(["missing", "missing"]);
  });
});
