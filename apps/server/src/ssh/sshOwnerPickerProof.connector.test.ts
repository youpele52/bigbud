import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { installIsolatedPickerOwner } from "./sshOwnerPickerProof.fixture.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const run = promisify(execFile);
const systemNc = "/usr/bin/nc";
const alias = "connector-fixture";

/** Live connector processes: the owner's helper is `nc <host> <port>` with exactly two operands. */
async function connectors(program: string) {
  const { stdout } = await run("/bin/ps", ["-axww", "-o", "pid=,command="], { env: {} });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.split(/\s+/).slice(1).join(" ").startsWith(`${program} `));
}

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "routes the owned master through only a qualified nc connector and never runs a substitute",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture, undefined, false, true);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      // A copy of Apple's signed nc in a private directory does not run usefully
      // (it never connects), so the approved PATH is /usr/bin plus a marker substitute.
      const customBin = "/usr/bin";
      const markerBin = path.join(fixture.root, "marker-bin");
      const marker = path.join(fixture.root, "marker-ran");
      await mkdir(markerBin, { mode: 0o700 });
      await writeFile(path.join(markerBin, "nc"), `#!/bin/sh\n/usr/bin/touch '${marker}'\n`, {
        mode: 0o700,
      });
      const imageSha256 = createHash("sha256")
        .update(await readFile(systemNc))
        .digest("hex");
      // The sandbox would let the marker run (and its shell write the marker),
      // so only the owner's policy keeps it from executing.
      const binary = await installIsolatedPickerOwner(
        fixture.root,
        fixture.clientSandboxPolicy,
        undefined,
        false,
        true,
        [systemNc, path.join(markerBin, "nc"), "/bin/sh", "/usr/bin/touch"],
      );
      await fixture.start();
      const input = { executionTargetId: options.targetId, path: fixture.folder };
      const configFile = path.join(fixture.root, "connector-config");
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
          ...options,
          binary,
          sql,
          aliasConfig: {
            file: configFile,
            alias,
            connector: { imageSha256, path: approved },
          },
        });
      };
      await storageScope(path.join(fixture.root, "connector.sqlite"), (sql) =>
        Effect.promise(async () => {
          // Positive: bare `nc` resolved on the approved PATH, owner-launched.
          const owner = await start(sql, "nc %h %p", [customBin]);
          try {
            await expect(owner.listRemoteFolders(input)).resolves.toMatchObject({
              path: fixture.folder,
            });
            const live = await connectors(path.join(customBin, "nc"));
            expect(live).toHaveLength(1);
            expect(live[0]).toMatch(
              new RegExp(` ${fixture.loopback.replaceAll(".", "\\.")} ${fixture.port}$`),
            );
            await expect(owner.listRemoteFolders(input)).resolves.toMatchObject({
              path: fixture.folder,
            });
            expect(fixture.connectionStarts()).toBe(1);
            expect(fixture.acceptedPublicKeys()).toBe(1);
          } finally {
            await owner.close();
          }
          expect(await connectors(path.join(customBin, "nc"))).toEqual([]);

          // Positive: absolute path to the qualified image, with exactly %h %p.
          const absolute = await start(sql, `${systemNc} %h %p`, [customBin]);
          try {
            await expect(absolute.listRemoteFolders(input)).resolves.toMatchObject({
              path: fixture.folder,
            });
            expect(fixture.connectionStarts()).toBe(2);
          } finally {
            await absolute.close();
          }

          const attempts = fixture.connectionStarts();
          // Substituted executable: earlier on PATH, or named absolutely.
          for (const [proxy, approved] of [
            ["nc %h %p", [markerBin, customBin]],
            [`${markerBin}/nc %h %p`, [customBin]],
          ] as const) {
            const substituted = await start(sql, proxy, [...approved]);
            try {
              await expect(substituted.listRemoteFolders(input)).rejects.toMatchObject({
                code: "routeUnavailable",
              });
            } finally {
              await substituted.close();
            }
          }
          // Shell syntax, extra flags and a wrapper are unsupported policy at startup.
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
          }
          await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
          expect(fixture.connectionStarts()).toBe(attempts);
          expect(await fixture.launchNames()).toEqual([]);
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
