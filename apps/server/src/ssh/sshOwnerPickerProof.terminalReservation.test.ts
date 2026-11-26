import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "reserves without launching, rejects a cancelled receipt, and opens only the exact scoped lease",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ allowPty: true });
    try {
      const options = await proofOptions(fixture, undefined, true);
      await fixture.start();
      vi.stubEnv("HOME", fixture.home);
      vi.stubEnv("PATH", fixture.env.PATH);
      await storageScope(path.join(fixture.root, "terminal-intent.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            workspaceRoot: fixture.folder,
          });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired") throw new Error("Expected fixture trust");
            await owner.approveTrust(trust.challenge);
            // Wait for the two key observations to appear before comparing connection starts.
            await vi.waitFor(() => expect(fixture.connectionStarts()).toBeGreaterThanOrEqual(2));
            const before = fixture.connectionStarts();
            const input = {
              cwd: fixture.folder,
              threadId: "thread-fixture",
              terminalId: "pane-fixture",
              cols: 96,
              rows: 34,
            };
            await expect(
              owner.prepareProofTerminal({ ...input, cwd: fixture.home }),
            ).rejects.toMatchObject({ code: "invalidOperands" });
            const cancelled = await owner.prepareProofTerminal(input);
            await expect(owner.proofTerminalStatus(cancelled.lease)).rejects.toMatchObject({
              code: "operationDenied",
            });
            expect(fixture.connectionStarts()).toBe(before);
            await owner.cancelProofTerminalReservation(cancelled.lease);
            await expect(owner.openReservedProofTerminal(cancelled.lease)).rejects.toMatchObject({
              code: "operationDenied",
            });
            const prepared = await owner.prepareProofTerminal(input);
            expect(prepared.lease).not.toEqual(cancelled.lease);
            expect(prepared.ownerEpoch).toEqual(cancelled.ownerEpoch);
            expect(prepared.targetGeneration).toEqual(cancelled.targetGeneration);
            expect(fixture.connectionStarts()).toBe(before);
            const terminal = await owner.openReservedProofTerminal(prepared.lease);
            expect(terminal.lease).toEqual(prepared.lease);
            expect(terminal.live).toBe(true);
            await expect(owner.connect()).rejects.toMatchObject({ code: "operationDenied" });
            await vi.waitFor(async () => {
              const state = await owner.proofTerminalStatus(prepared.lease);
              expect(Buffer.from(state.sample).toString()).toContain(
                "BIGBUD_SSH_OWNER_PROOF_PTY_SIZE:34 96",
              );
            });
            expect(fixture.acceptedPublicKeys()).toBe(1);
            await expect(owner.openReservedProofTerminal(prepared.lease)).rejects.toMatchObject({
              code: "operationDenied",
            });
            await expect(owner.closeProofTerminal(prepared.lease)).resolves.toMatchObject({
              pid: terminal.pid,
              live: false,
            });
            await expect(owner.openReservedProofTerminal(prepared.lease)).rejects.toMatchObject({
              code: "operationDenied",
            });
            expect(fixture.acceptedPublicKeys()).toBe(1);
            expect(await fixture.launchNames()).toEqual([]);
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  120_000,
);
