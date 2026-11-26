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

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "does not open a direct health connection alongside the selected POSIX master",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture, undefined, false, true);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      await storageScope(path.join(fixture.root, "master-health.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, posixPickerMaster: true, sql });
          const health = () => owner.sampleProofHealth(fixture.executionTargetId);
          const list = picker(owner, fixture);
          try {
            const baseline = fixture.connectionStarts();
            await expect(health()).rejects.toMatchObject({ code: "operationDenied" });
            expect(fixture.connectionStarts()).toBe(baseline);
            await expect(list()).resolves.toMatchObject({ path: fixture.folder });
            expect(fixture.connectionStarts()).toBe(baseline + 1);
            await expect(health()).rejects.toMatchObject({ code: "operationDenied" });
            await expect(list()).resolves.toMatchObject({ path: fixture.folder });
            expect(fixture.connectionStarts()).toBe(baseline + 1);
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
