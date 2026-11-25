import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { prepareProofOwner } from "./sshOwnerPickerProof.posixPassword.fixture.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

/**
 * X-BUD, live form. The fixture sshd runs with `MaxSessions 2`, and the owner
 * runs with a two-slot proof budget. Grant issuance is the bounded boundary;
 * it is not a live-session count (see the budget module docs). Three
 * interactive grants without a request deterministically exhaust the two
 * slots, so this test cannot pass with zero refusals. The refusal must be
 * `sessionQuota` (wire 28), never `authRequired` (wire 9).
 */
it.skipIf(process.platform !== "linux" || !pickerProofOptedIn)(
  "exhausts the two-slot grant budget with session quota, never auth",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture({
      syntheticPassword: true,
      maxSessions: 2,
    });
    try {
      expect(await readFile(path.join(fixture.root, "sshd_config"), "utf8")).toContain(
        "MaxSessions 2",
      );
      await writeFile(fixture.knownHosts, `${fixture.host} ${await fixture.getHostPublicKey()}\n`, {
        mode: 0o600,
      });
      const { options } = await prepareProofOwner(fixture, { sessionBudgetProof: 2 });
      await storageScope(path.join(fixture.root, "session-budget.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, sql });
          try {
            await owner.unlockSyntheticPosixPassword();
            const grants: (number | undefined)[] = [];
            for (let index = 0; index < 3; index += 1) {
              grants.push(
                await owner.issueProofGrantForTest({ kind: "listFolders", path: fixture.folder }),
              );
            }
            expect(grants.filter((code) => code === undefined)).toHaveLength(2);
            expect(grants).toContain(28);
            expect(grants).not.toContain(9);
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
