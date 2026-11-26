import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import {
  makeIsolatedInitiatingGitPush,
  type IsolatedInitiatingPushApproval,
} from "../git/Layers/GitCore.initiatingPush.composition.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import {
  branch,
  configureReceiver,
  git,
  gitEnv,
  init,
  seed,
} from "./sshOwnerPickerProof.gitReceive.fixture.ts";
import { live, withFixture, withOwner } from "./sshOwnerPickerProof.scopedNative.fixture.ts";

const effectiveUrl = "ssh://picker@127.0.0.1:22222/receive.git";

function metadataProbe(worktree: string): GitCoreShape["execute"] {
  return (input) => {
    const deny = () =>
      new GitCommandError({
        operation: input.operation,
        cwd: input.cwd,
        command: "blocked",
        detail: "Only isolated Git metadata reads are allowed.",
      });
    const [guard, command, subcommand] = input.args;
    if (
      input.cwd !== worktree ||
      input.executionTargetId !== undefined ||
      guard !== "--no-lazy-fetch" ||
      !(
        command === "rev-parse" ||
        command === "symbolic-ref" ||
        command === "check-ref-format" ||
        (command === "config" && subcommand === "--null") ||
        (command === "remote" && subcommand === "get-url")
      )
    )
      return Effect.fail(deny());
    return Effect.try({
      try: () => {
        const result = spawnSync("/usr/bin/git", input.args, {
          cwd: worktree,
          env: { ...gitEnv, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "" },
          timeout: 5000,
          encoding: "utf8",
          maxBuffer: 65536,
        });
        if (result.error || result.status === null) throw deny();
        return {
          code: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
      catch: deny,
    });
  };
}

it.skipIf(!live).each(["approved", "mismatched-startup-oid"] as const)(
  "runs the selected Git product caller through the native conductor (%s)",
  (mode) =>
    withFixture(async (fixture) => {
      const worktree = path.join(fixture.root, "client");
      git(fixture.root, [
        "init",
        "--template=",
        "--object-format=sha1",
        "--initial-branch=main",
        "client",
      ]);
      const remote = init(fixture.root, "receive.git");
      const old = seed(remote, "before product push");
      expect(seed(worktree, "before product push")).toBe(old);
      const sourceOid = seed(worktree, "after product push", old);
      const other = seed(worktree, "unapproved product push", old);
      git(remote, ["update-ref", branch, old]);
      git(worktree, ["update-ref", branch, sourceOid]);
      git(worktree, ["remote", "add", "origin", effectiveUrl]);
      git(worktree, ["config", "branch.main.remote", "origin"]);
      git(worktree, ["config", "branch.main.merge", branch]);
      git(worktree, ["update-ref", "refs/remotes/origin/main", old]);
      await configureReceiver(
        fixture.root,
        fixture.identity,
        fixture.knownHosts,
        fixture.port,
        old,
        sourceOid,
        false,
      );
      const gitDir = path.join(worktree, ".git");
      const repository = { worktree, gitDir, commonDir: gitDir };
      const executionTargetId = `ssh:${new URLSearchParams({ host: fixture.loopback, port: String(fixture.port), user: fixture.user })}`;
      const destination = {
        effectiveUrl,
        executionTargetId,
        host: fixture.loopback,
        user: fixture.user,
        port: fixture.port,
        repositoryPath: "/receive.git",
        expectedOldOid: old,
      };
      const common = {
        direction: "push",
        repository,
        remoteName: "origin",
        refs: { source: branch, destination: branch },
      } as const;
      await withOwner(
        fixture,
        {
          trackedPushFixture: {
            ...common,
            fixtureRoot: fixture.root,
            sourceOid: mode === "approved" ? sourceOid : other,
            destination,
          },
        },
        async (owner) => {
          const approval: IsolatedInitiatingPushApproval = {
            ...common,
            sourceOid,
            destinations: [{ ...destination, targetGeneration: owner.trackedGitTargetGeneration }],
          };
          const receiveTrackedPush = vi.fn(owner.receiveTrackedPush);
          const push = makeIsolatedInitiatingGitPush(metadataProbe(worktree), {
            receiveTrackedPush,
          });
          const receiver = path.join(fixture.root, "receiver-entered");
          // Changing the approved effective URL must stop at the product boundary, before the port.
          const [only] = approval.destinations;
          await expect(
            Effect.runPromise(
              push(worktree, {
                ...approval,
                destinations: [{ ...only, effectiveUrl: `${effectiveUrl}-other` }],
              }),
            ),
          ).rejects.toThrow();
          expect(receiveTrackedPush).not.toHaveBeenCalled();
          await expect(readFile(receiver)).rejects.toMatchObject({ code: "ENOENT" });
          const outcome = Effect.runPromise(push(worktree, approval));
          if (mode === "approved") {
            await expect(outcome).resolves.toMatchObject({
              status: "pushed",
              upstreamBranch: "origin/main",
            });
            expect(git(remote, ["for-each-ref", "--format=%(objectname) %(refname)"])).toBe(
              `${sourceOid} ${branch}`,
            );
            await expect(
              readFile(path.join(fixture.root, "receive.trace"), "utf8"),
            ).resolves.toContain(`receive-pack< ${old} ${sourceOid} ${branch}`);
            const dispatched = receiveTrackedPush.mock.lastCall?.[0];
            if (!dispatched) throw new Error("Missing native request");
            await expect(
              owner.receiveTrackedPush(dispatched, new AbortController().signal),
            ).resolves.toEqual({ status: "deniedBeforeDispatch" });
          } else {
            await expect(outcome).rejects.toThrow(/owner denied/);
            await expect(readFile(receiver)).rejects.toMatchObject({ code: "ENOENT" });
            expect(git(remote, ["rev-parse", branch])).toBe(old);
          }
          expect(receiveTrackedPush).toHaveBeenCalledTimes(1);
        },
      );
    }),
  60_000,
);
