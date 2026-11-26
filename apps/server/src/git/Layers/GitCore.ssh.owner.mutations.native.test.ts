import { Effect, Path } from "effect";
import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import { makeRemoteGitOps } from "./GitCore.remoteOps.ts";
import { makeProductionWorkspaceGitOwner } from "./GitCore.ssh.owner.production.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";

// B live run: branch, checkout, commit (with a repository hook) and worktree add/remove through
// the production owner, driven by the real GitCore remote ops. Same target as the C06 test
// (BIGBUD_TEST_C06_EXTERNAL_TARGET); `cwd/project` must be a clone with a `.hooks/pre-commit`
// hook (core.hooksPath=.hooks) that appends to `.git/hook.log`.
const external = readExternalV2Target(process.env.BIGBUD_TEST_C06_EXTERNAL_TARGET);

it.skipIf(external === undefined)(
  "creates, checks out and commits on a branch, and adds and removes a worktree",
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
      const cwd = `${parent}/project`;
      const branch = `live-${Date.now()}`;
      const worktree = `${parent}/project-${branch}`;
      const run = <A>(
        body: (ops: Effect.Success<ReturnType<typeof opsFor>>) => Effect.Effect<A, unknown>,
      ) => Effect.runPromise(opsFor().pipe(Effect.flatMap(body)));
      const opsFor = () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          return yield* (yield* makeRemoteGitOps(git, path, "/unused"))(descriptor.targetId);
        }).pipe(Effect.provide(Path.layer));

      await run(({ branchOps }) => branchOps.createBranch({ cwd, branch, checkout: true }));
      await run(({ branchOps }) => branchOps.checkoutBranch({ cwd, branch }));
      const committed = await run(({ statusOps }) =>
        Effect.gen(function* () {
          const context = yield* statusOps.prepareCommitContext(cwd, ["base.txt"]);
          expect(context?.stagedSummary).toBe("M\tbase.txt");
          return yield* statusOps.commit(cwd, `live: ${branch}`, "via the owner");
        }),
      );
      expect(committed.commitSha).toMatch(/^[0-9a-f]{40}$/u);
      const status = await run(({ statusOps }) => statusOps.statusDetailsLocal(cwd));
      expect(status.branch).toBe(branch);
      const range = await run(({ statusOps }) => statusOps.readRangeContext(cwd, "main"));
      expect(range.commitSummary).toContain(`live: ${branch}`);
      await run(({ worktreeOps }) =>
        worktreeOps.createWorktree({
          cwd,
          branch: "main",
          newBranch: `${branch}-wt`,
          path: worktree,
        }),
      );
      const listed = await run(({ branchOps }) => branchOps.listBranches({ cwd }));
      expect(listed.branches.some((entry) => entry.worktreePath === worktree)).toBe(true);
      await run(({ worktreeOps }) => worktreeOps.removeWorktree({ cwd, path: worktree }));
      await run(({ branchOps }) => branchOps.checkoutBranch({ cwd, branch: "main" }));
      await run(({ branchOps }) => branchOps.deleteBranch({ cwd, branch: `${branch}-wt` }));
    });
  },
  240_000,
);
