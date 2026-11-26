import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";
import { linuxPickerKeyDaemonLog } from "./sshPicker.loopback.fixture.linux.sandbox.ts";

const run = promisify(execFile);
// Debian netcat-openbsd; /usr/bin/nc is an alternatives symlink, which the owner refuses.
const packagedNc = "/usr/bin/nc.openbsd";
const optedIn =
  process.platform === "linux" && process.env.BIGBUD_TEST_SSH_OWNER_LINUX_CONNECTOR === "1";
const alias = "connector-fixture";

it.skipIf(!optedIn)(
  "Linux: routes the owned master only through a qualified custom-PATH nc and never runs a substitute",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture({ observeKeyDaemon: true });
    try {
      const binary = await fixture.installOwner(
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
        { ownedMasterLane: true },
      );
      await writeFile(fixture.knownHosts, `${fixture.host} ${await fixture.getHostPublicKey()}\n`, {
        mode: 0o600,
      });
      const customBin = path.join(fixture.root, "custom-bin");
      const markerBin = path.join(fixture.root, "marker-bin");
      const marker = path.join(fixture.root, "marker-ran");
      await mkdir(customBin, { mode: 0o700 });
      await mkdir(markerBin, { mode: 0o700 });
      await copyFile(packagedNc, path.join(customBin, "nc"));
      await run("/usr/bin/chmod", ["0700", path.join(customBin, "nc")]);
      await writeFile(path.join(markerBin, "nc"), `#!/bin/sh\n/usr/bin/touch '${marker}'\n`, {
        mode: 0o700,
      });
      const imageSha256 = createHash("sha256")
        .update(await readFile(packagedNc))
        .digest("hex");
      await fixture.start();
      const targetId = `ssh:${fixture.loopback}:${fixture.port}`;
      const input = { executionTargetId: targetId, path: fixture.folder };
      const configFile = path.join(fixture.root, "connector-config");
      // The fixture sshd starts with each owner launch; its log is per launch.
      const counts = async () => {
        const log = await readFile(path.join(fixture.root, linuxPickerKeyDaemonLog), "utf8");
        return {
          connections: log.match(/^Connection from /gm)?.length ?? 0,
          accepted: log.match(/^Accepted publickey /gm)?.length ?? 0,
        };
      };
      const start = async (sql: SqlClient.SqlClient, proxy: string, approved: string[]) => {
        await writeFile(
          configFile,
          [
            `Host ${alias}`,
            `  HostName ${fixture.loopback}`,
            `  Port ${fixture.port}`,
            `  User ${fixture.user}`,
            `  IdentityFile ${fixture.identity}`,
            `  UserKnownHostsFile ${fixture.knownHosts}`,
            `  ProxyCommand ${proxy}`,
            "",
          ].join("\n"),
          { mode: 0o600 },
        );
        return startPickerProofOwner({
          binary,
          profileBinding: randomBytes(32),
          targetId,
          lockFile: path.join(fixture.root, "owner.lock"),
          host: fixture.loopback,
          port: fixture.port,
          user: fixture.user,
          sshBinary: fixture.ssh,
          keyscanBinary: fixture.keyscan,
          identityFile: fixture.identity,
          knownHostsFile: fixture.knownHosts,
          sql,
          aliasConfig: { file: configFile, alias, connector: { imageSha256, path: approved } },
        });
      };
      const connectors = async () =>
        (await run("/usr/bin/ps", ["-eww", "-o", "args="], { env: {} })).stdout
          .split("\n")
          .filter((line) => line.startsWith(`${customBin}/nc `));
      await storageScope(path.join(fixture.root, "connector.sqlite"), (sql) =>
        Effect.promise(async () => {
          for (const proxy of ["nc %h %p", `${customBin}/nc %h %p`]) {
            const owner = await start(sql, proxy, [customBin]);
            try {
              await expect(owner.listRemoteFolders(input)).resolves.toMatchObject({
                path: fixture.folder,
              });
              await expect(owner.listRemoteFolders(input)).resolves.toMatchObject({
                path: fixture.folder,
              });
              expect(await connectors()).toEqual([
                `${customBin}/nc ${fixture.loopback} ${fixture.port}`,
              ]);
              expect(await counts()).toEqual({ connections: 1, accepted: 1 });
            } finally {
              await owner.close();
            }
            expect(await connectors()).toEqual([]);
          }
          // Substitutes: earlier on PATH, named absolutely, or the packaged alternatives symlink.
          for (const [proxy, approved] of [
            ["nc %h %p", [markerBin, customBin]],
            [`${markerBin}/nc %h %p`, [customBin]],
            ["nc %h %p", ["/usr/bin"]],
          ] as const) {
            const owner = await start(sql, proxy, [...approved]);
            try {
              await expect(owner.listRemoteFolders(input)).rejects.toMatchObject({
                code: "routeUnavailable",
              });
              expect(await counts()).toEqual({ connections: 0, accepted: 0 });
            } finally {
              await owner.close();
            }
          }
          for (const proxy of [
            `nc %h %p; ${markerBin}/nc`,
            `nc %h %p | ${markerBin}/nc`,
            "nc -w 3 %h %p",
            "nc %h %p -v",
            `/usr/bin/env ${markerBin}/nc %h %p`,
            `/bin/sh -c '${markerBin}/nc %h %p'`,
          ]) {
            await expect(start(sql, proxy, [customBin])).rejects.toMatchObject({
              code: "configUnsupported",
            });
            expect(await counts()).toEqual({ connections: 0, accepted: 0 });
          }
          await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
