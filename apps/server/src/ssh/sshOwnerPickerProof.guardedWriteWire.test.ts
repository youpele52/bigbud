import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { MAX_GUARDED_WRITE_BYTES } from "./sshOwnerPickerProof.guardedWriteStage.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "validates a 512 KiB guarded draft through real native grants without writing to the SSH host",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ allowInteractiveShell: true });
    try {
      const options = await proofOptions(fixture, undefined, true);
      const launcher = path.join(fixture.root, "start-guarded-stage-owner");
      await writeFile(
        launcher,
        `#!/bin/sh\nexport BIGBUD_SSH_OWNER_GUARDED_WRITE_STAGE_PROOF=1\nexec '${options.binary}' "$@"\n`,
        { mode: 0o700, flag: "wx" },
      );
      const file = path.join(fixture.folder, "draft.txt");
      await writeFile(file, "base\n");
      await fixture.start();
      await storageScope(path.join(fixture.root, "guarded-stage.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            binary: launcher,
            sql,
            workspaceRoot: fixture.folder,
            devInteractiveTerminal: true,
          });
          try {
            const input = {
              executionTargetId: options.targetId,
              workspaceRoot: fixture.folder,
              relativePath: "draft.txt",
              operationId: "0123456789abcdef0123456789abcdef",
              expectedSha256: createHash("sha256").update("base\n").digest(),
              contents: new Uint8Array(MAX_GUARDED_WRITE_BYTES).fill(65),
            };
            await expect(owner.validateProofGuardedWrite(input)).resolves.toEqual({
              state: "validatedNotDispatched",
            });
            await expect(owner.validateProofGuardedWrite(input)).rejects.toMatchObject({
              code: "operationDenied",
            });
            await owner.disconnect();
            await expect(
              owner.validateProofGuardedWrite({
                ...input,
                operationId: "fedcba9876543210fedcba9876543210",
              }),
            ).rejects.toMatchObject({ code: "targetDisconnected" });
            expect(await readFile(file, "utf8")).toBe("base\n");
            expect(fixture.connectionStarts()).toBe(0);
            expect(await fixture.launchNames()).toEqual([]);
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
