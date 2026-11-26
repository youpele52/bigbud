import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { expect, it } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  picker,
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "delivers only the declared synthetic locale through the real OpenSSH picker",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ observeLocale: true });
    try {
      const options = await proofOptions(fixture);
      const alias = "bigbud-proof-locale";
      const targetId = `ssh:${alias}`;
      const file = path.join(fixture.root, "locale_ssh_config");
      const systemFile = path.join(fixture.root, "locale_system_config");
      await writeFile(
        file,
        [
          `Host ${alias}`,
          `  HostName ${fixture.loopback}`,
          `  Port ${fixture.port}`,
          `  User ${fixture.user}`,
          `  IdentityFile ${fixture.identity}`,
          `  UserKnownHostsFile ${fixture.knownHosts}`,
          "  SendEnv LANG",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await writeFile(systemFile, "# No system SendEnv directives\n", { mode: 0o600 });
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`);

      const binary = path.join(fixture.root, "start-picker-owner-with-locale");
      // Supply exactly two synthetic locale values to the isolated owner, not to sshd.
      await writeFile(
        binary,
        `#!/bin/sh\nexec /usr/bin/env -i BIGBUD_SSH_OWNER_PICKER_PROOF=1 HOME='${fixture.root}' ` +
          `PATH=/usr/bin:/bin LANG=en_US.UTF-8 LC_TIME=fr_FR.UTF-8 '${options.binary}' "$@"\n`,
        { mode: 0o700 },
      );
      await fixture.start();
      await storageScope(path.join(fixture.root, "locale.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            binary,
            targetId,
            sql,
            aliasConfig: { file, alias, systemFile },
          });
          try {
            await expect(picker(owner, fixture, targetId)()).resolves.toMatchObject({
              path: fixture.folder,
              truncated: false,
            });
            expect(await fixture.readLocaleObservation()).toBe(
              "LANG=en_US.UTF-8\nLC_TIME=<unset>\n",
            );
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
