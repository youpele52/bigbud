import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
  "reports a dead master without replay and later admits a separate picker request",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ boundIdleMasterLifetime: true });
    try {
      const options = await proofOptions(fixture, undefined, false, true);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      await storageScope(path.join(fixture.root, "picker-transient.sqlite"), (sql) =>
        Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* Effect.acquireRelease(
              Effect.promise(() =>
                startPickerProofOwner({ ...options, sql, posixPickerMaster: true }),
              ),
              (value) => Effect.promise(() => value.close()),
            );
            yield* Effect.promise(async () => {
              const list = picker(owner, fixture);
              const initial = await list();
              expect(initial.path).toBe(fixture.folder);
              await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
              const entries = await readdir(fixture.root);
              const leases = entries.filter((entry) => /^bbcm-[A-Za-z0-9]{12}$/.test(entry));
              expect(leases).toHaveLength(1);
              const [directory] = leases;
              if (!directory) throw new Error("Expected an owned fixture lease");
              // Let the scoped sshd timeout close the old connection. The
              // owner itself stays alive; this is not owner crash or Disconnect.
              await vi.waitFor(
                () =>
                  expect(lstat(path.join(fixture.root, directory, "s"))).rejects.toMatchObject({
                    code: "ENOENT",
                  }),
                { timeout: 15_000 },
              );
              const before = fixture.connectionStarts();
              await expect(list()).rejects.toMatchObject({ cause: { code: "transportLost" } });
              expect(fixture.connectionStarts()).toBe(before);
              // Exceed the first retry window's 250ms upper bound without
              // requiring the test scheduler to observe its exact jitter.
              await delay(300);
              await expect(list()).resolves.toEqual(initial);
              await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(2));
              expect(await fixture.launchNames()).toEqual([]);
            });
          }),
        ),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);
