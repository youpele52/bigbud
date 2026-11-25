import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  picker,
  pickerProofOptedIn,
  proofOptions,
  rejectStartup,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "binds initiating account facts and explicit structured overrides to a disposable alias",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const uid = process.getuid?.();
      if (!uid) throw new Error("Expected the fixture's non-root initiating UID");
      const alias = "structured-facts-test";
      const targetId = `ssh:${alias}`;
      const label = "bound-override-key";
      const file = path.join(fixture.root, "route-facts.conf");
      const pins = path.join(
        fixture.root,
        `pins-${fixture.user}-${fixture.loopback}-${fixture.port}`,
      );
      await writeFile(pins, `${label} ${fixture.hostPublicKey}\n`, { mode: 0o600 });
      await writeFile(
        file,
        [
          `Host ${alias}`,
          "  HostName 127.0.0.9",
          "  User different-remote-login",
          "  Port 1",
          `  IdentityFile ${fixture.identity}`,
          `Match originalhost ${alias} localuser ${fixture.user} user ${fixture.user} host ${fixture.loopback}`,
          `  HostKeyAlias ${label}`,
          `  UserKnownHostsFile ${fixture.root}/pins-%r-%h-%p`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const overrides = { host: fixture.loopback, user: fixture.user, port: fixture.port };
      const localAccount = { uid, name: fixture.user };
      await fixture.start();
      await storageScope(path.join(fixture.root, "route-facts.sqlite"), (sql) =>
        Effect.promise(async () => {
          const start = (
            aliasConfig: NonNullable<Parameters<typeof startPickerProofOwner>[0]["aliasConfig"]>,
          ) =>
            startPickerProofOwner({ ...options, sql, targetId, knownHostsFile: pins, aliasConfig });
          // Match localuser without a trusted initiating account is a located policy rejection.
          await expect(start({ file, alias, overrides })).rejects.toMatchObject({
            code: "configUnsupported",
            diagnostic: { location: { directive: "Match", source: "user_config", line: 6 } },
          });
          await rejectStartup(
            start({ file, alias, overrides, localAccount: { ...localAccount, uid: uid + 1 } }),
            "ownerUnavailable",
          );
          // Without the port override, %p selects an absent trust file: a located rejection.
          await expect(
            start({
              file,
              alias,
              localAccount,
              overrides: { host: fixture.loopback, user: fixture.user },
            }),
          ).rejects.toMatchObject({
            code: "configUnsupported",
            diagnostic: {
              location: { directive: "UserKnownHostsFile", source: "user_config", line: 8 },
            },
          });
          expect(fixture.connectionStarts()).toBe(0);
          const owner = await start({ file, alias, overrides, localAccount });
          try {
            await expect(picker(owner, fixture, targetId)()).resolves.toMatchObject({
              path: fixture.folder,
            });
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
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
