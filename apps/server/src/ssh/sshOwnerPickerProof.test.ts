import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { withOutsideMaster } from "./sshOwnerPickerProof.fixture.ts";
import {
  picker,
  pickerProofOptedIn,
  proofOptions,
  rejectStartup,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";

function fingerprint(key: string) {
  const base64 = key.split(" ")[1];
  if (!base64) throw new Error("fixture did not generate an Ed25519 public key");
  return `SHA256:${createHash("sha256").update(Buffer.from(base64, "base64")).digest("base64url").replaceAll("-", "+").replaceAll("_", "/")}`;
}

it.skipIf(!pickerProofOptedIn)(
  "isolated S1 owner enforces trust and durable Disconnect at the picker boundary",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const db = path.join(fixture.root, "proof.sqlite");
      const start = (sql: SqlClient.SqlClient, major?: number, ownerBinary = options.binary) =>
        startPickerProofOwner({
          ...options,
          binary: ownerBinary,
          sql,
          ...(major === undefined ? {} : { major }),
        });
      // Any unintended TypeScript fallback resolves the old fixture recorder, never ambient SSH.
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      const listing = {
        path: fixture.folder,
        homePath: fixture.home,
        folders: [
          { name: "alpha", isGitRepo: false },
          { name: "Z repo", isGitRepo: true },
        ],
        truncated: false,
      };
      await fixture.start();
      await storageScope(db, (sql) =>
        Effect.promise(async () => {
          const owner = await start(sql);
          try {
            const list = picker(owner, fixture);
            const beforeSecondOwner = fixture.connectionStarts();
            await rejectStartup(start(sql), "ownerUnavailable");
            expect(fixture.connectionStarts()).toBe(beforeSecondOwner);
            await expect(list()).rejects.toMatchObject({ cause: { code: "trustRequired" } });
            expect(fixture.acceptedPublicKeys()).toBe(0);
            expect(await readFile(fixture.knownHosts, "utf8")).toBe("");
            const firstObservation = await owner.inspectTrust();
            if (firstObservation.state !== "approvalRequired") {
              throw new Error("Unknown key did not require approval");
            }
            expect(firstObservation.fingerprint).toBe(fingerprint(fixture.hostPublicKey));
            expect(firstObservation.challenge.length).toBeGreaterThan(0);

            // The observed key cannot be approved if the endpoint changes before approval.
            await fixture.stop();
            await fixture.start("changed");
            await expect(owner.approveTrust(firstObservation.challenge)).rejects.toMatchObject({
              code: "hostKeyChanged",
            });
            expect(fixture.acceptedPublicKeys()).toBe(0);
            expect(await readFile(fixture.knownHosts, "utf8")).toBe("");
            await fixture.stop();
            await fixture.start();
            await expect(owner.approveTrust(firstObservation.challenge)).rejects.toMatchObject({
              code: "operationDenied",
            });
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired") throw new Error("The key was not approved yet");
            expect(trust.fingerprint).toBe(fingerprint(fixture.hostPublicKey));
            await owner.approveTrust(trust.challenge);
            await expect(list()).resolves.toEqual(listing);
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
            await fixture.stop();
            await expect(list()).rejects.toMatchObject({ cause: { code: "transportLost" } });
            await fixture.start();
            await expect(list()).resolves.toEqual(listing);
            await owner.disconnect();
            const deniedBaseline = fixture.connectionStarts();
            await expect(list()).rejects.toMatchObject({ cause: { code: "targetDisconnected" } });
            expect(fixture.connectionStarts()).toBe(deniedBaseline);
          } finally {
            await owner.close();
          }
        }),
      );

      await storageScope(db, (sql) =>
        Effect.promise(async () => {
          const owner = await start(sql);
          try {
            const list = picker(owner, fixture);
            const afterRestart = fixture.connectionStarts();
            await expect(list()).rejects.toMatchObject({ cause: { code: "targetDisconnected" } });
            expect(fixture.connectionStarts()).toBe(afterRestart);
            await owner.connect();
            await expect(list()).resolves.toEqual(listing);
            const pinned = await readFile(fixture.knownHosts, "utf8");
            await fixture.stop();
            await fixture.start("changed");
            await expect(list()).rejects.toMatchObject({ cause: { code: "hostKeyChanged" } });
            expect(fixture.acceptedPublicKeys()).toBe(0);
            expect(await readFile(fixture.knownHosts, "utf8")).toBe(pinned);
            await owner.killForTest();
            const afterDeath = fixture.connectionStarts();
            await expect(list()).rejects.toMatchObject({ cause: { code: "ownerUnavailable" } });
            await rejectStartup(start(sql, 99), "versionIncompatible");
            await rejectStartup(
              start(sql, undefined, path.join(fixture.root, "absent-owner")),
              "ownerUnavailable",
            );
            expect(fixture.connectionStarts()).toBe(afterDeath);
            expect(await fixture.launchNames()).toEqual([]);
          } finally {
            await owner.close();
          }
        }),
      );

      // The real SQLite service still opens and can answer local queries after owner failure.
      await storageScope(db, (sql) =>
        Effect.gen(function* () {
          expect(yield* sql`SELECT 1 AS live`).toEqual([{ live: 1 }]);
          expect(
            yield* sql`SELECT seq FROM ssh_target_transition WHERE target_id = ${fixture.executionTargetId}`,
          ).toEqual([{ seq: 2 }]);
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  120_000,
);

it.skipIf(!pickerProofOptedIn)(
  "isolated S1 owner binds alias approval and listing to one immutable direct policy",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const db = path.join(fixture.root, "alias-proof.sqlite");
      const alias = "bigbud-proof-host";
      const targetId = `ssh:${alias}`;
      const hostKeyAlias = "bigbud-proof-key";
      const marker = path.join(fixture.root, "helper-must-not-run");
      const file = path.join(fixture.root, "proof_ssh_config");
      const include = path.join(fixture.root, "route-10.conf");
      const rootConfig = "Include route-*.conf\n";
      const systemFile = path.join(fixture.root, "proof_system_config");
      const firstIdentity = path.join(fixture.home, `id-${alias}`);
      const expandedPins = path.join(fixture.home, `pins-${fixture.port}`);
      await chmod(fixture.home, 0o700);
      await writeFile(expandedPins, "", { mode: 0o600 });
      execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", firstIdentity], {
        cwd: fixture.root,
        env: fixture.env,
        timeout: 5_000,
      });
      const directConfig = [
        "Host unrelated",
        `  ProxyCommand /usr/bin/touch ${marker}`,
        "Host bigbud-proof-* !bigbud-proof-excluded",
        `  HostName ${fixture.loopback}`,
        `  Port ${fixture.port}`,
        "  IdentityFile ~/id-%n",
        "  UserKnownHostsFile ~/pins-%p",
        "",
      ].join("\n");
      await writeFile(file, rootConfig, { mode: 0o600 });
      await writeFile(include, directConfig, { mode: 0o600 });
      // The synthetic system source cannot override Port, but supplies the trust name
      // and the only key this disposable daemon will accept.
      await writeFile(
        systemFile,
        `Host *\n  User ${fixture.user}\n  Port 1\n  HostKeyAlias ${hostKeyAlias}\n  IdentityFile ${fixture.identity}\n`,
        { mode: 0o600 },
      );
      await fixture.start();
      await storageScope(db, (sql) =>
        Effect.promise(async () => {
          const start = () =>
            startPickerProofOwner({
              ...options,
              targetId,
              sql,
              identityFile: firstIdentity,
              knownHostsFile: expandedPins,
              aliasConfig: { file, alias, systemFile },
            });
          const previous = await start();
          let staleChallenge: Uint8Array;
          try {
            const trust = await previous.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected first-use alias trust");
            staleChallenge = trust.challenge;
            await vi.waitFor(() => expect(fixture.connectionStarts()).toBeGreaterThan(0));
            await writeFile(include, directConfig.replace(`Port ${fixture.port}`, "Port 2"));
            const beforePolicyDenied = fixture.connectionStarts();
            await expect(previous.approveTrust(staleChallenge)).rejects.toMatchObject({
              code: "configUnsupported",
            });
            expect(fixture.connectionStarts()).toBe(beforePolicyDenied);
            expect(await readFile(expandedPins, "utf8")).toBe("");
          } finally {
            await previous.close();
          }

          await writeFile(include, directConfig);
          const owner = await start();
          try {
            await expect(owner.approveTrust(staleChallenge)).rejects.toMatchObject({
              code: "operationDenied",
            });
            const approval = await owner.inspectTrust();
            if (approval.state !== "approvalRequired")
              throw new Error("Expected fresh alias approval");
            await owner.approveTrust(approval.challenge);
            const pins = `${hostKeyAlias} ${fixture.hostPublicKey}\n`;
            expect(await readFile(expandedPins, "utf8")).toBe(pins);
            // The independently owned master uses its own on-disk trust file.
            await writeFile(fixture.knownHosts, pins);
            await withOutsideMaster(fixture, hostKeyAlias, async (assertOutsideMasterAlive) => {
              await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
              const list = picker(owner, fixture, targetId);
              await expect(list()).resolves.toMatchObject({
                path: fixture.folder,
                truncated: false,
              });
              // Listing opened its own authenticated connection, not the existing master.
              await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(2));
              await writeFile(path.join(fixture.root, "route-00.conf"), "# new match\n", {
                mode: 0o600,
              });
              const beforeListDenied = fixture.connectionStarts();
              await expect(list()).rejects.toMatchObject({ cause: { code: "configUnsupported" } });
              expect(fixture.connectionStarts()).toBe(beforeListDenied);
              await owner.disconnect();
              await assertOutsideMasterAlive();
            });
          } finally {
            await owner.close();
          }
          await writeFile(file, `${rootConfig}Match exec "/usr/bin/touch ${marker}"\n`);
          const beforeBootDenied = fixture.connectionStarts();
          await rejectStartup(start(), "configUnsupported");
          expect(fixture.connectionStarts()).toBe(beforeBootDenied);
          await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
