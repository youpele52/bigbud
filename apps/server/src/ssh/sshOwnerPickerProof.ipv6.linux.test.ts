import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { listRemoteFoldersEffect } from "../ws/wsRemoteFolders.ts";
import { runSshCommand } from "./sshProcess.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { PickerProofStartupConfigError } from "./sshOwnerPickerProof.startupDiagnostic.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

vi.mock("./sshProcess.ts", () => ({ runSshCommand: vi.fn() }));

it.skipIf(process.platform !== "linux" || !pickerProofOptedIn)(
  "applies scoped OpenSSH alias policy on Linux IPv6 and refuses active system GSSAPI before SSH",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture({
      addressFamily: "inet6",
      observeKeyDaemon: true,
    });
    try {
      const alias = "linux-proof-ipv6";
      const keyAlias = "linux-ipv6-trust-name";
      const targetId = `ssh:${alias}`;
      const userConfig = path.join(fixture.root, "user-config");
      const systemRoot = path.join(fixture.root, "system");
      const systemConfig = path.join(systemRoot, "config");
      const included = path.join(fixture.root, "includes");
      await mkdir(included, { mode: 0o700 });
      await mkdir(systemRoot, { mode: 0o700 });
      const write = (file: string, text: string) => writeFile(file, text, { mode: 0o600 });
      await write(
        userConfig,
        [
          `Host ${alias}`,
          "  HostName ::1",
          "  AddressFamily inet6",
          `  User ${fixture.user}`,
          "  Include includes/*.conf",
          `  UserKnownHostsFile ${fixture.knownHosts}`,
          "",
        ].join("\n"),
      );
      await write(
        path.join(included, "10-route.conf"),
        [
          `Match host ::1 originalhost ${alias}`,
          `  Port ${fixture.port}`,
          `  IdentityFile ${fixture.identity}`,
          "",
        ].join("\n"),
      );
      const systemPolicy = (gssapiScope: string) =>
        [
          `Host ${gssapiScope}`,
          "  GSSAPIAuthentication yes",
          `Host ${alias}`,
          `  Port ${fixture.port + 1}`,
          `  HostKeyAlias ${keyAlias}`,
          "  GlobalKnownHostsFile none",
          "",
        ].join("\n");
      await write(systemConfig, systemPolicy(alias));
      const binary = await fixture.installOwner(
        fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      await storageScope(path.join(fixture.root, "ipv6-owner.sqlite"), (sql) =>
        Effect.promise(async () => {
          const start = () =>
            startPickerProofOwner({
              binary,
              sql,
              targetId,
              profileBinding: randomBytes(32),
              lockFile: path.join(fixture.root, "owner.lock"),
              sshBinary: fixture.ssh,
              keyscanBinary: fixture.keyscan,
              host: fixture.loopback,
              port: fixture.port,
              user: fixture.user,
              identityFile: fixture.identity,
              knownHostsFile: fixture.knownHosts,
              aliasConfig: { file: userConfig, alias, systemFile: systemConfig },
            });
          const denied = await start().then(
            async (unexpected) => {
              await unexpected.close();
              throw new Error("Owner admitted active GSSAPI policy");
            },
            (cause: unknown) => cause,
          );
          expect(denied).toBeInstanceOf(PickerProofStartupConfigError);
          expect(denied).toMatchObject({
            code: "configUnsupported",
            diagnostic: {
              location: { directive: "GSSAPIAuthentication", source: "system_config", line: 2 },
            },
          });
          const deniedLog = await fixture.readKeyDaemonLog();
          expect(deniedLog).toContain(`Server listening on ::1 port ${fixture.port}.`);
          expect(deniedLog).not.toMatch(/Connection from |Accepted publickey /);
          expect(await readFile(fixture.knownHosts, "utf8")).toBe("");

          await write(systemConfig, systemPolicy("demonstrably-unrelated"));
          const owner = await start();
          try {
            const list = () =>
              Effect.runPromise(
                listRemoteFoldersEffect(
                  { executionTargetId: targetId, path: fixture.folder },
                  (input) => owner.listRemoteFolders(input),
                ),
              );
            await expect(list()).rejects.toMatchObject({ cause: { code: "trustRequired" } });
            expect(await fixture.readKeyDaemonLog()).not.toMatch(/Connection from /);
            const observed = await owner.inspectTrust();
            if (observed.state !== "approvalRequired")
              throw new Error("Expected exact-key approval");
            await owner.approveTrust(observed.challenge);
            await expect(list()).resolves.toEqual({
              path: fixture.folder,
              homePath: fixture.home,
              folders: [
                { name: "alpha", isGitRepo: false },
                { name: "Z repo", isGitRepo: true },
              ],
              truncated: false,
            });
            expect(await fixture.readKeyDaemonLog()).toMatch(
              /Accepted publickey .* from ::1 port /,
            );
            expect(await readFile(fixture.knownHosts, "utf8")).toBe(
              `${keyAlias} ${await fixture.getHostPublicKey()}\n`,
            );
            expect(runSshCommand).not.toHaveBeenCalled();
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);
