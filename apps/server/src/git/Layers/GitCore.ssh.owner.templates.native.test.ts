import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import { makeProductionWorkspaceGitOwner } from "./GitCore.ssh.owner.production.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";

// B live run: stash, `checkout -b`, `branch -D`, `remote add`, `init` and commands inside a
// linked worktree through the production owner. Same target variable as the C06 test
// (BIGBUD_TEST_C06_EXTERNAL_TARGET); `cwd/project` is a clone on `main`, `cwd/fresh` an empty
// directory, and `cwd/project-linked` must not exist yet.
const external = readExternalV2Target(process.env.BIGBUD_TEST_C06_EXTERNAL_TARGET);

it.skipIf(external === undefined)(
  "runs stash, new and force-deleted branches, remote add, init and linked-worktree Git",
  async () => {
    await withProductionV2Owner(external!, 1, async ({ handle, targets }) => {
      const { descriptor, cwd: parent } = targets[0]!;
      const bound = handle.target(descriptor);
      const trust = await bound.inspectTrust();
      if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
      const registration = {
        handle,
        descriptorFor: async () => descriptor,
      } as unknown as SshOwnerProductionRegistration;
      const git = makeSshGitExecutor(makeProductionWorkspaceGitOwner(() => registration));
      const run = (cwd: string, args: string[]) =>
        Effect.runPromise(
          git({
            operation: "GitCore.live",
            cwd,
            args,
            executionTargetId: descriptor.targetId,
            allowNonZeroExit: true,
          }),
        );
      const project = `${parent}/project`;
      const linked = `${parent}/project-linked`;

      expect((await run(project, ["stash", "push", "-m", "live wip"])).code).toBe(0);
      expect((await run(project, ["stash", "list"])).stdout).toContain("live wip");
      expect((await run(project, ["stash", "pop", "stash@{0}"])).code).toBe(0);
      expect((await run(project, ["stash", "list"])).stdout).toBe("");

      expect((await run(project, ["checkout", "-b", "topic"])).code).toBe(0);
      expect((await run(project, ["stash", "push"])).code).toBe(0);
      expect((await run(project, ["checkout", "main"])).code).toBe(0);
      expect((await run(project, ["branch", "-D", "--", "topic"])).code).toBe(0);
      expect((await run(project, ["stash", "drop"])).code).toBe(0);

      const added = await run(project, [
        "remote",
        "add",
        "upstream",
        "git@example.invalid:o/r.git",
      ]);
      expect(added.code).toBe(0);
      expect((await run(project, ["remote", "-v"])).stdout).toContain(
        "upstream\tgit@example.invalid:o/r.git",
      );

      expect((await run(`${parent}/fresh`, ["init"])).code).toBe(0);
      expect((await run(`${parent}/fresh`, ["stash", "list"])).code).toBe(0);

      const linkedBranch = `linked-${Date.now()}`;
      const wt = await run(project, ["worktree", "add", "-b", linkedBranch, linked, "main"]);
      expect(wt.code).toBe(0);
      expect((await run(linked, ["branch", "--show-current"])).stdout).toBe(`${linkedBranch}\n`);
      expect((await run(linked, ["add", "-A"])).code).toBe(0);
      expect((await run(linked, ["worktree", "list", "--porcelain"])).stdout).toContain(
        `worktree ${linked}\nHEAD`,
      );
      expect((await run(project, ["worktree", "remove", "--force", linked])).code).toBe(0);
      expect((await run(project, ["branch", "-D", "--", linkedBranch])).code).toBe(0);
    });
  },
  240_000,
);
