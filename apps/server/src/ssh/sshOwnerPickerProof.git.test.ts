import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { makeRemoteGitOps } from "../git/Layers/GitCore.remoteOps.ts";
import { RemoteAgentGitExecutorService } from "../remote-agent/remoteAgentGit.ts";
import { makeConfiguredRemoteAgentLayers } from "../remote-agent/remoteAgentServerLayer.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { DevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "runs direct-workspace Git reads and refreshes clean-to-untracked status through the real owner",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const cwd = path.join(fixture.folder, "clean git root");
      await mkdir(cwd);
      const executionTargetId = fixture.executionTargetId.replace(
        "transport=agent",
        "transport=direct-ssh",
      );
      const nested = path.join(cwd, "nested");
      await mkdir(nested);
      const untrackedName = "fixture git name.txt";
      const setupGit = (args: string[]) =>
        execFileSync("/usr/bin/git", args, {
          cwd,
          env: {
            HOME: fixture.home,
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
          stdio: "ignore",
        });
      setupGit(["init", "-q"]);
      const metadataFile = path.join(cwd, "metadata.txt");
      await writeFile(metadataFile, "tracked\n");
      setupGit(["add", "--", "metadata.txt"]);
      setupGit([
        "-c",
        "user.name=Git fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "Clean baseline",
      ]);
      const origin = "ssh://fixture.invalid/repo";
      setupGit(["config", "remote.origin.url", origin]);
      setupGit(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      const options = await proofOptions(fixture);
      await fixture.start();
      // Any unexpected legacy launch can reach only the isolated recorder.
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      await storageScope(path.join(fixture.root, "git-proof.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            workspaceRoot: cwd,
            targetId: executionTargetId,
          });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected isolated first-use trust");
            await owner.approveTrust(trust.challenge);
            activateDevSshOwner();
            const picker = makeSshOwnerDevPicker({
              executionTargetId,
              host: fixture.host,
              startOwner: async () => owner,
            });
            const session = {
              kind: "unix" as const,
              alias: "proof-native-git",
              targetId: executionTargetId,
              fixture: { ...fixture, folder: cwd },
              picker,
              sql,
              terminal: undefined,
            };
            const gitLayer = makeConfiguredRemoteAgentLayers(
              Layer.succeed(DevSshOwnerRuntime, { session }),
            ).services;
            const execute = await Effect.runPromise(
              Effect.service(RemoteAgentGitExecutorService).pipe(
                Effect.provide(gitLayer),
                Effect.provideService(SqlClient.SqlClient, sql),
              ),
            );
            const scoped = { cwd, executionTargetId, allowNonZeroExit: true };
            const probe = {
              ...scoped,
              operation: "GitCore.isInsideWorkTree",
              args: ["rev-parse", "--is-inside-work-tree"],
              timeoutMs: 5_000,
              maxOutputBytes: 4_096,
            };
            const statusRequest = {
              ...scoped,
              operation: "GitCore.statusDetails.status",
              args: ["status", "--porcelain=2", "--branch", "-uall"],
            };
            await expect(Effect.runPromise(execute(probe))).resolves.toMatchObject({
              code: 0,
              stdout: "true\n",
            });
            const beforeStatus = fixture.connectionStarts();
            const { statusOps } = await Effect.runPromise(
              Effect.gen(function* () {
                const paths = yield* Path.Path;
                const forTarget = yield* makeRemoteGitOps(execute, paths, fixture.root);
                return yield* forTarget(executionTargetId);
              }).pipe(Effect.provide(Path.layer)),
            );
            await expect(Effect.runPromise(statusOps.status(scoped))).resolves.toMatchObject({
              isRepo: true,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            });
            await writeFile(path.join(cwd, untrackedName), "cached names remain data\n");
            await expect(Effect.runPromise(statusOps.status(scoped))).resolves.toMatchObject({
              isRepo: true,
              hasWorkingTreeChanges: true,
              workingTree: {
                files: [{ path: untrackedName, insertions: 0, deletions: 0 }],
                insertions: 0,
                deletions: 0,
              },
            });
            const afterStatus = fixture.connectionStarts();
            expect(afterStatus).toBeGreaterThan(beforeStatus);
            const nestedStatus = await Effect.runPromise(
              Effect.result(statusOps.status({ ...scoped, cwd: nested })),
            );
            expect(nestedStatus).toMatchObject({
              _tag: "Failure",
              failure: { detail: expect.stringContaining("Only the exact development workspace") },
            });
            expect(fixture.connectionStarts()).toBe(afterStatus);
            expect(await fixture.launchNames()).toEqual([]);

            await writeFile(metadataFile, "tracked\nstaged\n");
            setupGit(["add", "--", "metadata.txt"]);
            await writeFile(metadataFile, "tracked\nstaged\nunstaged\n");
            const status = await Effect.runPromise(execute(statusRequest));
            expect(status.code).toBe(0);
            expect(status.stdout).toContain(`? ${untrackedName}`);
            expect(status.stdoutTruncated).toBe(false);
            for (const [operation, args, stdout] of [
              [
                "GitCore.statusDetails.stagedNumstat",
                ["diff", "--cached", "--numstat"],
                "1\t0\tmetadata.txt\n",
              ],
              [
                "GitCore.statusDetails.unstagedNumstat",
                ["diff", "--numstat"],
                "1\t0\tmetadata.txt\n",
              ],
              [
                "GitCore.statusDetails.defaultRef",
                ["symbolic-ref", "refs/remotes/origin/HEAD"],
                "refs/remotes/origin/main\n",
              ],
              ["GitCore.originRemoteExists", ["remote", "get-url", "origin"], `${origin}\n`],
            ] as const) {
              await expect(
                Effect.runPromise(execute({ ...scoped, operation, args: [...args] })),
              ).resolves.toMatchObject({ code: 0, stdout });
            }
            const calls = fixture.connectionStarts();
            const unsupported = await Effect.runPromise(
              Effect.result(execute({ ...scoped, operation: "GitCore.fetch", args: ["fetch"] })),
            );
            expect(unsupported).toMatchObject({
              _tag: "Failure",
              failure: {
                detail: "This Git request is not supported by the direct workspace Git owner.",
              },
            });
            const wrong = await Effect.runPromise(
              Effect.result(execute({ ...probe, cwd: fixture.home })),
            );
            expect(wrong).toMatchObject({
              _tag: "Failure",
              failure: { detail: expect.stringContaining("Only the exact development workspace") },
            });
            expect(fixture.connectionStarts()).toBe(calls);
            await owner.disconnect();
            const disconnected = await Effect.runPromise(Effect.result(execute(statusRequest)));
            expect(disconnected).toMatchObject({
              _tag: "Failure",
              failure: { cause: { _tag: "RemoteTargetDisconnectedError" } },
            });
            expect(fixture.connectionStarts()).toBe(calls);
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
