import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import type { ExecuteGitInput } from "../Services/GitCore.ts";
import { makeProductionWorkspaceGitOwner } from "./GitCore.ssh.owner.production.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";
import { COMMIT_FILE_DIFF_ARGS, COMMIT_NUMSTAT_ARGS } from "./GitHistory.commit.ts";
import { COMMIT_LOG_FORMAT } from "./GitHistory.parse.ts";
import { makeProductionGitHubCliOwnerTransport } from "./GitHubCli.owner.production.ts";

// C06/U7 (B) live run against a disposable sshd (the OrbStack Debian guest), with
// target/debug/bigbud-ssh-owner built on this host. `cwd` is the workspace parent holding
// `project` (a clone with tracking config, a committed symlink, a modified `base.txt`, an
// untracked `new.txt`, an untracked `escape` symlink to a directory outside the root, and
// branches main/side) and `origin.git` (bare, branches main/feature).
// BIGBUD_TEST_C06_EXTERNAL_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
//   "knownHostsFile":…,"cwd":"/tmp/c06/ws","remoteBinary":"/unused"}'
const external = readExternalV2Target(process.env.BIGBUD_TEST_C06_EXTERNAL_TARGET);

it.skipIf(external === undefined)(
  "serves status, diff, branch list, discard and gh pr checkout through the production owner",
  async () => {
    await withProductionV2Owner(external!, 1, async ({ handle, targets }) => {
      const { descriptor, cwd: workspaceParent } = targets[0]!;
      const bound = handle.target(descriptor);
      const trust = await bound.inspectTrust();
      if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
      const registration = {
        handle,
        descriptorFor: async () => descriptor,
      } as unknown as SshOwnerProductionRegistration;
      const cwd = `${workspaceParent}/project`;
      const git = makeSshGitExecutor(makeProductionWorkspaceGitOwner(() => registration));
      const run = (operation: string, args: string[], extra: Partial<ExecuteGitInput> = {}) =>
        Effect.runPromise(
          git({
            operation,
            args,
            cwd,
            executionTargetId: descriptor.targetId,
            allowNonZeroExit: true,
            ...extra,
          }),
        );

      const status = await run("GitCore.statusDetails.status", [
        "status",
        "--porcelain=2",
        "--branch",
        "-uall",
      ]);
      expect(status.stdout).toContain("# branch.head main");
      expect(status.stdout).toContain("# branch.upstream origin/main");
      expect(status.stdout).toContain("? new.txt");
      const numstat = await run("GitCore.statusDetails.unstagedNumstat", ["diff", "--numstat"]);
      expect(numstat.stdout).toBe("1\t0\tbase.txt\n");
      const untracked = await run("GitCore.statusDetails.fallbackNumstat", [
        "diff",
        "--numstat",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "/dev/null",
        "--",
        "new.txt",
      ]);
      // Git 2.47 prints the `--no-index` pair; the status parser keeps the new side.
      expect(untracked.stdout).toMatch(/^1\t0\t(?:\/dev\/null => )?new\.txt\n$/u);
      const diff = await run("GitCore.readWorkingTreeDiff.trackedAgainstHead", [
        "diff",
        "--find-renames",
        "HEAD",
        "--",
        "base.txt",
      ]);
      expect(diff.stdout).toContain("+changed\n");
      const fileDiff = await run("GitCore.readWorkingTreeDiff.untrackedFile", [
        "diff",
        "--no-index",
        "/dev/null",
        "new.txt",
      ]);
      expect(fileDiff.code).toBe(1);
      expect(fileDiff.stdout).toContain("+fresh\n");
      const branches = await run("GitCore.listLocalBranchNames", [
        "branch",
        "--list",
        "--no-column",
        "--format=%(refname:short)",
      ]);
      // The mutation live test may leave its own `live-*` branches behind.
      expect(branches.stdout.split("\n")).toEqual(expect.arrayContaining(["main", "side"]));
      // An untracked symlink escaping the root is never read.
      const escape = await Effect.runPromise(
        Effect.flip(
          git({
            operation: "GitCore.readWorkingTreeDiff.untrackedFile",
            args: ["diff", "--no-index", "/dev/null", "escape/secret.txt"],
            cwd,
            executionTargetId: descriptor.targetId,
            allowNonZeroExit: true,
          }),
        ),
      );
      expect(escape.detail).toBe("The direct workspace Git owner could not complete the request.");
      // History panel: a commit page, its changed files, and one file's capped patch.
      const log = await run("GitCore.listCommits", ["log", "--max-count=2", COMMIT_LOG_FORMAT]);
      const head = log.stdout.split("\0")[0]!;
      expect(head).toMatch(/^[0-9a-f]{40}$/u);
      const files = await run("GitCore.getCommitDetails.numstat", [
        ...COMMIT_NUMSTAT_ARGS,
        head,
        "--",
      ]);
      expect(files.stdout).toBe("1\t0\tlink\0");
      const capped = await run(
        "GitCore.getCommitFileDiff",
        [...COMMIT_FILE_DIFF_ARGS, head, "--", ":(top,literal)link"],
        { maxOutputBytes: 10, truncateOutputAtMaxBytes: true },
      );
      expect(capped).toMatchObject({ stdoutTruncated: true });
      expect(capped.stdout).toHaveLength(10);
      // Discard (restore) of the tracked change, then status is clean apart from untracked.
      await run(
        "GitCore.discardChanges.restore",
        ["restore", "--source=HEAD", "--staged", "--worktree", "--", ":(top,literal)base.txt"],
        { timeoutMs: 30_000 },
      );
      const after = await run("GitCore.statusDetails.unstagedNumstat", ["diff", "--numstat"]);
      expect(after.stdout).toBe("");

      // gh pr checkout in a local clone whose origin is on this target: one owner upload lease,
      // shim pinned to that repository. A stand-in `gh` runs the fetch and checkout.
      const local = mkdtempSync(join(tmpdir(), "bbc06-"));
      try {
        const url = `ssh://${descriptor.user}@${descriptor.host}:${descriptor.port}${workspaceParent}/origin.git`;
        execFileSync("git", ["init", "-q", "-b", "main", local]);
        execFileSync("git", ["-C", local, "remote", "add", "origin", url]);
        const transport = makeProductionGitHubCliOwnerTransport({
          owner: () => registration,
          records: async () => [
            { executionTargetId: descriptor.targetId, workspaceRoot: workspaceParent },
          ],
          targets: async () => [
            { hosts: [descriptor.host], user: descriptor.user, port: descriptor.port },
          ],
          runGh: async (_args, options) => {
            const script =
              "git fetch -q origin refs/heads/feature:refs/heads/feature && git checkout -q feature";
            // Async: the owner stream bridge lives in this process's event loop.
            const child = spawn("/bin/sh", ["-c", script], { cwd: options.cwd, env: options.env });
            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
            const code = await new Promise<number>((resolve) =>
              child.on("close", (status) => resolve(status ?? -1)),
            );
            return { stdout: "", stderr, code };
          },
        });
        const result = await transport.execute(
          { cwd: local, args: ["pr", "checkout", "7", "--force"], timeoutMs: 30_000 },
          new AbortController().signal,
        );
        expect(result).toMatchObject({ code: 0 });
        expect(
          execFileSync("git", ["-C", local, "branch", "--show-current"], { encoding: "utf8" }),
        ).toBe("feature\n");
      } finally {
        rmSync(local, { recursive: true, force: true });
      }
    });
  },
  180_000,
);
