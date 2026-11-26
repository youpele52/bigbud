import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExecutionTargetId } from "@bigbud/contracts";
import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { withProductionWorkspaceOwner } from "../ws/wsSshOwnerProduction.workspace.ts";
import { makeSelectedOwnerReadinessProbe } from "./remoteWorkspaceReadiness.ts";
import {
  createSelectedSessionFsProvider,
  type SessionFsOwnerCapability,
} from "./remoteWorkspaceSessionFsBridge.ownerProvider.ts";

// W2 T-files live proof: Copilot/ACP session-FS over the production owner
// (readiness, mkdir, write, read, append, exists, stat, readdir, rename, rm) against an already-running disposable
// sshd. Same target JSON shape as `wsSshOwnerProduction.workspace.native.test.ts`.
const external = readExternalV2Target(process.env.BIGBUD_TEST_SSH_OWNER_PRODUCTION_FILES_TARGET);
const enabled =
  external !== undefined && (process.platform === "darwin" || process.platform === "linux");

it.skipIf(!enabled)(
  "serves session-FS through the production owner's typed workspace verbs",
  async () => {
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const { descriptor, cwd } = targets[0]!;
        const bound = handle.target(descriptor);
        const trust = await bound.inspectTrust();
        if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
        const registration = {
          handle,
          descriptorFor: async () => descriptor,
        } as unknown as SshOwnerProductionRegistration;
        const targetId = descriptor.targetId as ExecutionTargetId;
        const sessionFsOwner: SessionFsOwnerCapability = {
          targetId,
          workspaceRoot: cwd,
          withOwner: (id, use, signal) =>
            withProductionWorkspaceOwner(() => registration, id, use, signal),
        };
        const readiness = await makeSelectedOwnerReadinessProbe(sessionFsOwner)({
          location: "remote",
          executionTargetId: targetId,
          cwd,
        });
        expect(readiness).toBeDefined();
        const bridgeCwd = await mkdtemp(path.join(tmpdir(), "bb-sessionfs-"));
        try {
          const provider = createSelectedSessionFsProvider({
            capability: sessionFsOwner,
            initialCwd: cwd,
            bridgeCwd,
            stateRoot: path.join(bridgeCwd, "state"),
          });
          await provider.mkdir(`${cwd}/sfs`, false);
          await provider.writeFile(`${cwd}/sfs/note.txt`, "session fs\n");
          expect(await provider.readFile(`${cwd}/sfs/note.txt`)).toBe("session fs\n");
          // Every remote entry operation runs a typed owner verb.
          await provider.appendFile(`${cwd}/sfs/note.txt`, "more\n");
          expect(await provider.readFile(`${cwd}/sfs/note.txt`)).toBe("session fs\nmore\n");
          await provider.appendFile(`${cwd}/sfs/new.txt`, "created\n");
          expect(await provider.exists(`${cwd}/sfs/new.txt`)).toBe(true);
          expect(await provider.exists(`${cwd}/sfs/absent`)).toBe(false);
          const stat = await provider.stat(`${cwd}/sfs/note.txt`);
          expect(stat).toMatchObject({ isFile: true, isDirectory: false, size: 16 });
          expect(Date.parse(stat.mtime)).toBeGreaterThan(Date.parse("2026-01-01"));
          expect((await provider.stat(`${cwd}/sfs`)).isDirectory).toBe(true);
          expect((await provider.readdir(`${cwd}/sfs`)).toSorted()).toEqual([
            "new.txt",
            "note.txt",
          ]);
          expect(await provider.readdirWithTypes(cwd)).toEqual(
            expect.arrayContaining([{ name: "sfs", type: "directory" }]),
          );
          await provider.rename(`${cwd}/sfs/new.txt`, `${cwd}/sfs/moved.txt`);
          // POSIX rename replaces a file destination.
          await provider.rename(`${cwd}/sfs/moved.txt`, `${cwd}/sfs/note.txt`);
          expect(await provider.readFile(`${cwd}/sfs/note.txt`)).toBe("created\n");
          await expect(provider.rm(`${cwd}/sfs`, false, false)).rejects.toMatchObject({
            code: "ENOTEMPTY",
          });
          await provider.rm(`${cwd}/sfs/note.txt`, false, false);
          await provider.rm(`${cwd}/sfs/note.txt`, false, true);
          await expect(provider.stat(`${cwd}/sfs/note.txt`)).rejects.toMatchObject({
            code: "ENOENT",
          });
          await provider.rm(`${cwd}/sfs`, true, false);
          expect(await provider.exists(`${cwd}/sfs`)).toBe(false);
          // Paths outside the root never reach the owner.
          await expect(provider.readFile("/etc/passwd")).rejects.toThrow();
          await expect(provider.readdir("/etc")).rejects.toThrow();
        } finally {
          await rm(bridgeCwd, { recursive: true, force: true });
        }
      },
      { binding: {} },
    );
  },
  120_000,
);
