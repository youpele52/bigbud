import { execFile, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  approve,
  live,
  withFixture,
  withOwner,
} from "./sshOwnerPickerProof.scopedNative.fixture.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";
import {
  linuxPickerSandboxArgs,
  linuxPickerTools,
  renderLinuxPickerDaemonEntrypoint,
  renderLinuxPickerOwnerLauncher,
  renderLinuxPickerSshdConfig,
} from "./sshPicker.loopback.fixture.linux.sandbox.ts";

const root = "/tmp/bigbud-picker-linux-test123";
const uid = 1000;
const gid = 1001;
const execute = promisify(execFile);

function binds(args: string[]) {
  const values: string[][] = [];
  for (const [index, arg] of args.entries()) {
    if (["--bind", "--ro-bind", "--ro-bind-try"].includes(arg)) {
      values.push(args.slice(index, index + 3));
    }
  }
  return values;
}

describe("Linux picker sandbox configuration", () => {
  it("requires an owned temporary path and non-root user and group", () => {
    for (const candidate of ["/tmp", "/home/picker", `${root}/../escape`, `${root} x`]) {
      expect(() => linuxPickerSandboxArgs(candidate, uid, gid)).toThrow("private Linux picker");
    }
    expect(() => linuxPickerSandboxArgs(root, 0, gid)).toThrow("non-root");
    expect(() => linuxPickerSandboxArgs(root, uid, 0)).toThrow("non-root");
  });

  it("uses private namespaces, drops capabilities and mounts no ambient account or SSH files", () => {
    const args = linuxPickerSandboxArgs(root, uid, gid);
    expect(args).toEqual(
      expect.arrayContaining([
        "--unshare-user",
        "--unshare-net",
        "--unshare-pid",
        "--disable-userns",
        "--new-session",
        "--die-with-parent",
        "--clearenv",
      ]),
    );
    expect(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2)).toEqual([
      "--cap-drop",
      "ALL",
    ]);
    expect(binds(args)).toEqual([
      ["--ro-bind", "/usr/bin", "/usr/bin"],
      ["--ro-bind", "/bin", "/bin"],
      ["--ro-bind", "/usr/lib", "/usr/lib"],
      ...["/lib", "/lib64", "/usr/lib64", "/usr/libexec"].map((dir) => ["--ro-bind-try", dir, dir]),
      ["--ro-bind", linuxPickerTools.sshd, linuxPickerTools.sshd],
      ...["passwd", "group", "nsswitch.conf"].map((name) => [
        "--ro-bind",
        `${root}/${name}`,
        `/etc/${name}`,
      ]),
      ["--bind", root, root],
    ]);
    expect(args).not.toContain("SSH_AUTH_SOCK");
  });

  it("adds only the verified awk executable at Debian's alternatives hop", () => {
    const originalBinds = binds(linuxPickerSandboxArgs(root, uid, gid));
    const withAwk = binds(linuxPickerSandboxArgs(root, uid, gid, false, "/usr/bin/mawk"));
    expect(withAwk.filter((args) => args[2] !== "/etc/alternatives/awk")).toEqual(originalBinds);
    expect(withAwk.filter((args) => args[2] === "/etc/alternatives/awk")).toEqual([
      ["--ro-bind", "/usr/bin/mawk", "/etc/alternatives/awk"],
    ]);
  });

  it("allows only the fixture key on IPv4 loopback and launches the owner after sshd is ready", () => {
    const config = renderLinuxPickerSshdConfig(root);
    expect(config.split("\n")).toEqual(
      expect.arrayContaining([
        "ListenAddress 127.0.0.1:22222",
        `HostKey ${root}/host-key`,
        `AuthorizedKeysFile ${root}/authorized_keys`,
        "AllowUsers picker",
        "AuthenticationMethods publickey",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PermitUserRC no",
        "UsePAM no",
        "DisableForwarding yes",
        "PermitTTY no",
      ]),
    );
    expect(config).not.toMatch(/Include|AcceptEnv|AuthorizedKeysCommand/);
    const script = renderLinuxPickerDaemonEntrypoint(root, uid, gid);
    expect(script).toContain("Server listening on 127.0.0.1 port 22222.");
    expect(script).toContain('! kill -0 "$daemon"');
    expect(script).toContain('exec "$@"');
    const launcher = renderLinuxPickerOwnerLauncher(
      [
        ...linuxPickerSandboxArgs(root, uid, gid),
        "--ro-bind",
        `${root}/machine-id`,
        "/etc/machine-id",
      ],
      root,
    );
    expect(launcher).toMatch(/^#!\/bin\/sh\nexec '\/usr\/bin\/bwrap' /);
    expect(launcher).toContain(
      `'/etc/machine-id' '--remount-ro' '/' '--setenv' 'BIGBUD_SSH_OWNER_PICKER_RO_SYSTEM_TOOLS' '1' '--' '/bin/sh' '${root}/start-daemon' '${root}/picker-owner' "$@"`,
    );
    for (const input of [script, launcher]) {
      expect(spawnSync("/bin/sh", ["-n"], { input }).status).toBe(0);
    }
  });
});

it.skipIf(!live)("binds only the qualified read-only Linux fixture OpenSSH images", () =>
  withFixture(async (fixture) => {
    const launcher = await fixture.installOwner(
      fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      { mountDeploymentPublicKey: true, mountWorkspaceMachineId: true },
    );
    const valid = await readFile(launcher, "utf8");
    const scope = { reuseLauncher: true };
    for (const remove of [
      " '--remount-ro' '/'",
      " '--setenv' 'BIGBUD_SSH_OWNER_PICKER_RO_SYSTEM_TOOLS' '1'",
    ]) {
      expect(valid).toContain(remove);
      await writeFile(launcher, valid.replace(remove, ""));
      let ready = false;
      await expect(
        withOwner(
          fixture,
          {},
          async () => {
            ready = true;
          },
          scope,
        ),
      ).rejects.toThrow();
      expect(ready).toBe(false);
      expect(await readFile(fixture.knownHosts, "utf8")).toBe("");
    }
    await writeFile(launcher, valid);
    await withOwner(
      fixture,
      {},
      async (owner, executionTargetId) => {
        await approve(owner);
        await expect(
          owner.listRemoteFolders({ executionTargetId, path: fixture.folder }),
        ).resolves.toEqual({
          path: fixture.folder,
          homePath: fixture.home,
          folders: [
            { name: "alpha", isGitRepo: false },
            { name: "Z repo", isGitRepo: true },
          ],
          truncated: false,
        });
      },
      scope,
    );
  }),
);

it.skipIf(process.env.BIGBUD_TEST_PICKER_LOOPBACK_LINUX !== "1")(
  "authenticates with real system SSH in a private Linux namespace without seeding picker trust",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture();
    try {
      await fixture.start();
      expect(await readFile(fixture.knownHosts, "utf8")).toBe("");
      const launcher = await fixture.installOwner("/bin/sh");
      const testTrust = path.join(fixture.root, "test_known_hosts");
      const publicKey = await readFile(path.join(fixture.root, "host-key.pub"), "utf8");
      await writeFile(testTrust, `${fixture.host} ${publicKey}`, { mode: 0o600 });
      const { stdout } = await execute(
        launcher,
        [
          "-c",
          [
            "set -eu",
            'test "$HOME" = "$1"',
            'test -z "${SSH_AUTH_SOCK+x}"',
            "test ! -e /etc/ssh",
            "tail -n +3 /proc/net/dev | cut -d : -f 1 | tr -d ' '",
            'shift; exec "$@"',
          ].join("\n"),
          "sh",
          fixture.home,
          fixture.ssh,
          "-4",
          "-T",
          "-F",
          "/dev/null",
          "-p",
          String(fixture.port),
          "-l",
          fixture.user,
          "-i",
          fixture.identity,
          "-o",
          "BatchMode=yes",
          "-o",
          "IdentityAgent=none",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "GlobalKnownHostsFile=none",
          "-o",
          `UserKnownHostsFile=${testTrust}`,
          "-o",
          "UpdateHostKeys=no",
          "-o",
          "VerifyHostKeyDNS=no",
          "-o",
          "ConnectTimeout=2",
          "--",
          fixture.loopback,
          'printf "%s\\n" "$HOME"',
        ],
        {
          cwd: fixture.root,
          env: { HOME: "/ambient-home", SSH_AUTH_SOCK: "/ambient-agent" },
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      expect(stdout.trim().split("\n")).toEqual(["lo", fixture.home]);
      expect(await readFile(fixture.knownHosts, "utf8")).toBe("");
    } finally {
      await fixture.dispose();
    }
  },
);
