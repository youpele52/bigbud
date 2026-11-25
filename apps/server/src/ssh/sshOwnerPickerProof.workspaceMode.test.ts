import path from "node:path";

import { Effect } from "effect";
import { expect, it } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "admits workspace-mode inspection only for the bound root and pinned host",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      await fixture.start();
      await storageScope(path.join(fixture.root, "workspace-mode.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            workspaceRoot: fixture.folder,
            sql,
          });
          try {
            const input = { executionTargetId: options.targetId, root: fixture.folder };
            const before = fixture.connectionStarts();
            await expect(
              owner.inspectProofWorkspaceMode({ ...input, root: fixture.home }),
            ).rejects.toMatchObject({ code: "workspacePathDenied" });
            await expect(owner.inspectProofWorkspaceMode(input)).rejects.toMatchObject({
              code: "trustRequired",
            });
            expect(fixture.connectionStarts()).toBe(before);
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired") throw new Error("expected new host key");
            await owner.approveTrust(trust.challenge);
            // The fixture's remote host is macOS. A real pinned SSH child runs
            // the fixed recipe and returns the typed platform refusal over IPC.
            await expect(owner.inspectProofWorkspaceMode(input)).resolves.toEqual({
              state: "refused",
              reason: "notLinux",
            });
            expect(fixture.acceptedPublicKeys()).toBe(1);
            await owner.disconnect();
            const disconnected = fixture.connectionStarts();
            await expect(owner.inspectProofWorkspaceMode(input)).rejects.toMatchObject({
              code: "targetDisconnected",
            });
            expect(fixture.connectionStarts()).toBe(disconnected);
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
