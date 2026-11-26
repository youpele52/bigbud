import { readFile, rename, writeFile } from "node:fs/promises";
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

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "authenticates with mixed quoted trust paths and refuses a replaced source before dialing",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const alias = "proof-quoted-trust";
      const targetId = `ssh:${alias}`;
      const config = path.join(fixture.root, "quoted.conf");
      const primary = path.join(fixture.root, "primary pins");
      const secondary = path.join(fixture.root, "secondary pins");
      const global = path.join(fixture.root, "global pins");
      const first = "# no pin in the primary file\n";
      const selected = `quoted-host ${fixture.hostPublicKey}\n`;
      await writeFile(primary, first, { mode: 0o600 });
      await writeFile(secondary, selected, { mode: 0o600 });
      await writeFile(global, "# no global pin\n", { mode: 0o600 });
      await writeFile(
        config,
        [
          `Host ${alias}`,
          `  HostName ${fixture.loopback}`,
          `  Port ${fixture.port}`,
          `  User ${fixture.user}`,
          "  HostKeyAlias 'quoted-host'",
          `  IdentityFile "${fixture.identity}"`,
          `  UserKnownHostsFile "${primary}" '${secondary}'`,
          `  GlobalKnownHostsFile '${global}'`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await fixture.start();
      await storageScope(path.join(fixture.root, "quoted.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            targetId,
            knownHostsFile: primary,
            sql,
            aliasConfig: { file: config, alias },
          });
          try {
            const list = picker(owner, fixture, targetId);
            await expect(owner.inspectTrust()).resolves.toMatchObject({ state: "verified" });
            expect(fixture.acceptedPublicKeys()).toBe(0);
            await expect(list()).resolves.toMatchObject({ path: fixture.folder });
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
            const before = fixture.connectionStarts();
            expect(await readFile(primary, "utf8")).toBe(first);
            await rename(secondary, path.join(fixture.root, "old-secondary-pins"));
            await writeFile(secondary, selected, { mode: 0o600 });
            await expect(list()).rejects.toMatchObject({ cause: { code: "configUnsupported" } });
            expect(fixture.connectionStarts()).toBe(before);
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
