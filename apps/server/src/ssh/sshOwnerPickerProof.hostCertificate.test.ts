import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  picker,
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const principal = "configured-ca-host";
const certAlgorithm = "ssh-ed25519-cert-v01@openssh.com";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "uses only a scoped Ed25519 CA to authenticate the real picker handshake",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const alias = "proof-host-certificate";
      const targetId = `ssh:${alias}`;
      const config = path.join(fixture.root, "cert-config");
      const caStore = path.join(fixture.root, "ca-pins");
      const signer = path.join(fixture.root, "signer");
      const otherSigner = path.join(fixture.root, "other-signer");
      const cert = path.join(fixture.root, "host-key-cert.pub");
      const hostKey = path.join(fixture.root, "host-key.pub");
      const sshdConfig = path.join(fixture.root, "sshd_config");
      const originalServer = await readFile(sshdConfig, "utf8");
      const certServer = `${originalServer}\nHostCertificate ${cert}\n`;
      const keygen = (args: string[]) =>
        execFileSync("/usr/bin/ssh-keygen", args, {
          env: fixture.env,
          cwd: fixture.root,
          timeout: 5_000,
          stdio: "ignore",
        });
      for (const ca of [signer, otherSigner]) {
        keygen(["-q", "-t", "ed25519", "-N", "", "-f", ca]);
      }
      const caPublic = (await readFile(`${signer}.pub`, "utf8"))
        .trim()
        .split(" ")
        .slice(0, 2)
        .join(" ");
      const caRecord = `@cert-authority ${principal} ${caPublic}\n`;
      await writeFile(caStore, caRecord, { mode: 0o600 });
      await writeFile(
        config,
        [
          `Host ${alias}`,
          `  HostName ${fixture.loopback}`,
          `  Port ${fixture.port}`,
          `  User ${fixture.user}`,
          `  HostKeyAlias ${principal}`,
          `  HostKeyAlgorithms ${certAlgorithm}`,
          `  IdentityFile ${fixture.identity}`,
          "  UserKnownHostsFile none",
          `  GlobalKnownHostsFile ${caStore}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const setCertificate = async (ca: string, name: string, validity: string) => {
        await fixture.stop();
        keygen(["-q", "-s", ca, "-I", "fixture-host", "-h", "-n", name, "-V", validity, hostKey]);
        await writeFile(sshdConfig, certServer);
        await fixture.start();
      };
      await setCertificate(signer, principal, "-1h:+1h");
      const options = await proofOptions(fixture);
      await storageScope(path.join(fixture.root, "certificate.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            targetId,
            aliasConfig: { file: config, alias },
          });
          try {
            const list = picker(owner, fixture, targetId);
            const beforeInspect = fixture.connectionStarts();
            await expect(owner.inspectTrust()).rejects.toMatchObject({ code: "configUnsupported" });
            await expect(owner.approveTrust(new Uint8Array(32))).rejects.toMatchObject({
              code: "operationDenied",
            });
            expect(fixture.connectionStarts()).toBe(beforeInspect);
            await expect(list()).resolves.toEqual({
              path: fixture.folder,
              homePath: fixture.home,
              folders: [
                { name: "alpha", isGitRepo: false },
                { name: "Z repo", isGitRepo: true },
              ],
              truncated: false,
            });
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
            expect(await readFile(caStore, "utf8")).toBe(caRecord);

            const revoked = `${caRecord}@revoked ${principal} ${caPublic}\n`;
            await writeFile(caStore, revoked);
            const beforeRevocation = fixture.connectionStarts();
            await expect(list()).rejects.toMatchObject({ cause: { code: "hostKeyChanged" } });
            expect(fixture.connectionStarts()).toBe(beforeRevocation);
            expect(await readFile(caStore, "utf8")).toBe(revoked);

            await writeFile(caStore, "# no matching authority\n");
            await expect(owner.inspectTrust()).rejects.toMatchObject({
              code: "trustStoreReadOnly",
            });
            await expect(list()).rejects.toMatchObject({ cause: { code: "trustStoreReadOnly" } });
            expect(fixture.connectionStarts()).toBe(beforeRevocation);
            expect(await readFile(caStore, "utf8")).toBe("# no matching authority\n");
            await writeFile(caStore, caRecord);

            const rawPin = `${principal} ${fixture.hostPublicKey}\n`;
            await writeFile(fixture.knownHosts, rawPin);
            const rejectsHandshake = async () => {
              const before = fixture.connectionStarts();
              await expect(list()).rejects.toMatchObject({
                // OpenSSH can reject before it emits the standard host-key
                // diagnostic. In either case no credentials reach the server.
                cause: { code: expect.stringMatching(/^(hostKeyChanged|transportLost)$/) },
              });
              await vi.waitFor(() => expect(fixture.connectionStarts()).toBeGreaterThan(before));
              expect(fixture.acceptedPublicKeys()).toBe(0);
            };
            for (const [ca, name, validity] of [
              [otherSigner, principal, "-1h:+1h"],
              [signer, "wrong-principal", "-1h:+1h"],
              [signer, principal, "-2h:-1h"],
            ] as const) {
              await setCertificate(ca, name, validity);
              await rejectsHandshake();
            }

            await fixture.stop();
            keygen([
              "-q",
              "-s",
              signer,
              "-I",
              "tampered",
              "-h",
              "-n",
              principal,
              "-V",
              "-1h:+1h",
              hostKey,
            ]);
            const [kind, blob] = (await readFile(cert, "utf8")).split(" ");
            if (kind !== certAlgorithm || !blob) throw new Error("Missing fixture certificate");
            const bytes = Buffer.from(blob, "base64");
            bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
            await writeFile(cert, `${kind} ${bytes.toString("base64")} fixture-tampered\n`);
            await fixture.start();
            await rejectsHandshake();

            await fixture.stop();
            await writeFile(sshdConfig, originalServer);
            await fixture.start();
            await rejectsHandshake();
            expect(await readFile(caStore, "utf8")).toBe(caRecord);
            expect(await readFile(fixture.knownHosts, "utf8")).toBe(rawPin);
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
