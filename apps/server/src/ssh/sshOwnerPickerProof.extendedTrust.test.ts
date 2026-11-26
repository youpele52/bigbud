import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
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

it.skipIf(!pickerProofOptedIn).each(["existing-pin", "approval", "single-file"] as const)(
  "enforces ordered private user and system trust sources (%s)",
  async (mode) => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const alias = "proof-extended-trust";
      const label = "approved-host";
      const targetId = `ssh:${alias}`;
      const secondary = path.join(fixture.root, "secondary-pins");
      const global = path.join(fixture.root, "global-pins");
      const file = path.join(fixture.root, "proof_config");
      const existing = `unrelated ${fixture.wrongPublicKey}`;
      const globalComment = "# no applicable system pin\n";
      const firstContent =
        mode === "single-file" ? `${existing}\n${label} ${fixture.hostPublicKey}\n` : existing;
      await writeFile(fixture.knownHosts, firstContent, { mode: 0o600 });
      await writeFile(
        secondary,
        mode === "existing-pin" ? `${label} ${fixture.hostPublicKey}\n` : "",
        { mode: 0o600 },
      );
      if (mode === "existing-pin") {
        execFileSync("/usr/bin/ssh-keygen", ["-H", "-f", secondary], {
          cwd: fixture.root,
          env: fixture.env,
          timeout: 5_000,
          stdio: "ignore",
        });
        await chmod(secondary, 0o600);
      }
      await writeFile(global, globalComment, { mode: 0o600 });
      await writeFile(
        file,
        [
          `Host ${alias}`,
          `  HostName ${fixture.loopback}`,
          `  Port ${fixture.port}`,
          `  User ${fixture.user}`,
          `  HostKeyAlias ${label}`,
          `  IdentityFile ${fixture.identity}`,
          mode === "single-file"
            ? `  UserKnownHostsFile ${fixture.knownHosts}`
            : `  UserKnownHostsFile ${fixture.knownHosts} ${secondary}`,
          mode === "single-file"
            ? "  GlobalKnownHostsFile none"
            : `  GlobalKnownHostsFile ${global}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await fixture.start();
      await storageScope(path.join(fixture.root, "extended-trust.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            targetId,
            sql,
            aliasConfig: { file, alias },
          });
          try {
            const list = picker(owner, fixture, targetId);
            if (mode === "approval") {
              await expect(list()).rejects.toMatchObject({ cause: { code: "trustRequired" } });
              const original = await owner.inspectTrust();
              if (original.state !== "approvalRequired")
                throw new Error("Expected first-use approval");
              await vi.waitFor(() => expect(fixture.connectionStarts()).toBeGreaterThan(0));
              await writeFile(secondary, "# changed since the trust observation\n");
              const before = fixture.connectionStarts();
              await expect(owner.approveTrust(original.challenge)).rejects.toMatchObject({
                code: "hostKeyChanged",
              });
              expect(fixture.connectionStarts()).toBe(before);
              expect(await readFile(fixture.knownHosts, "utf8")).toBe(existing);
              const fresh = await owner.inspectTrust();
              if (fresh.state !== "approvalRequired") throw new Error("Expected fresh challenge");
              await owner.approveTrust(fresh.challenge);
              expect(await readFile(fixture.knownHosts, "utf8")).toBe(
                `${existing}\n${label} ${fixture.hostPublicKey}\n`,
              );
              expect(await readFile(secondary, "utf8")).toBe(
                "# changed since the trust observation\n",
              );
            } else {
              if (mode === "existing-pin")
                expect((await readFile(secondary, "utf8")).startsWith("|1|")).toBe(true);
              await expect(owner.inspectTrust()).resolves.toMatchObject({ state: "verified" });
            }
            await expect(list()).resolves.toMatchObject({ path: fixture.folder });
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
            expect(await readFile(global, "utf8")).toBe(globalComment);
            if (mode !== "approval")
              expect(await readFile(fixture.knownHosts, "utf8")).toBe(firstContent);
            const before = fixture.connectionStarts();
            for (const [marker, code] of [
              ["@revoked", "hostKeyChanged"],
              ["@cert-authority", "configUnsupported"],
            ] as const) {
              const revocationSource = mode === "single-file" ? fixture.knownHosts : global;
              await writeFile(revocationSource, `${marker} ${label} ${fixture.hostPublicKey}\n`);
              await expect(list()).rejects.toMatchObject({ cause: { code } });
              expect(fixture.connectionStarts()).toBe(before);
            }
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
