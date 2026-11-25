import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { probeSelectedSshOwnerWorkspaceReadiness } from "../remote-workspace-bridge/remoteWorkspaceReadiness.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "probes the exact selected workspace with stock OpenSSH and refuses scope mismatch and Disconnect before dialing",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ allowInteractiveShell: true });
    try {
      const options = await proofOptions(fixture, undefined, true);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      await storageScope(path.join(fixture.root, "workspace-readiness.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            workspaceRoot: fixture.folder,
            devInteractiveTerminal: true,
          });
          const input = { executionTargetId: options.targetId, workspaceRoot: fixture.folder };
          try {
            await expect(probeSelectedSshOwnerWorkspaceReadiness(owner, input)).resolves.toEqual({
              os: "darwin",
              architecture: process.arch === "arm64" ? "arm64" : "x86_64",
            });
            const before = fixture.connectionStarts();
            expect(before).toBe(1);
            await expect(
              probeSelectedSshOwnerWorkspaceReadiness(owner, {
                ...input,
                workspaceRoot: fixture.home,
              }),
            ).rejects.toMatchObject({ code: "workspacePathDenied" });
            expect(fixture.connectionStarts()).toBe(before);
            await owner.disconnect();
            await expect(
              probeSelectedSshOwnerWorkspaceReadiness(owner, input),
            ).rejects.toMatchObject({
              code: "targetDisconnected",
            });
            expect(fixture.connectionStarts()).toBe(before);
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
