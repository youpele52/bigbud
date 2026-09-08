import { Effect, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { configureRemoteAgentOwners } from "./remoteAgentOwners.ts";
import { installManagerFixture, installInput } from "./remoteAgentInstallManager.fixtures.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import * as Control from "./remoteAgentControl.ts";
import { RemoteAgentGitActionBinding } from "./remoteAgentGit.action.ts";
import { bindRemoteGitMutations } from "./remoteAgentGit.mutations.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";

it("binds every public Git mutation before all substeps and rejects unidentified remote calls", async () => {
  const local = ManagedRuntime.make(NodeSqlite.layer({ filename: ":memory:" }));
  const fixture = installManagerFixture();
  await fixture.manager.install(installInput);
  const runtime = (await fixture.control.registry.read()).builds[0]!.runtime;
  const selected = { runtime, expectedEpoch: "epoch", connectionId: "original" };
  const select = vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(selected);
  vi.spyOn(Control, "openRemoteAgentControl").mockResolvedValue(fixture.control);
  const objects = [
    "createWorktree",
    "removeWorktree",
    "fetchPullRequestBranch",
    "fetchRemoteBranch",
    "ensureRemote",
    "setBranchUpstream",
    "createBranch",
    "checkoutBranch",
    "renameBranch",
    "deleteBranch",
    "initRepo",
  ];
  const primitives = [
    "pullCurrentBranch",
    "fetch",
    "discardChanges",
    "prepareCommitContext",
    "pushCurrentBranch",
    "commit",
  ];
  const routes: string[] = [];
  const methods = Object.fromEntries(
    [...objects, ...primitives].map((method) => [
      method,
      () =>
        Effect.gen(function* () {
          routes.push((yield* RemoteAgentGitActionBinding).connectionId!);
          select.mockResolvedValue({ ...selected, connectionId: "activated-between-substeps" });
          yield* Effect.yieldNow;
          routes.push((yield* RemoteAgentGitActionBinding).connectionId!);
        }),
    ]),
  );
  try {
    await local.runPromise(Effect.andThen(OwnersMigration, ReplayMigration));
    configureRemoteAgentOwners(await local.runPromise(makeRemoteAgentRuntimeBindings));
    const git = bindRemoteGitMutations(methods as unknown as GitCoreShape);
    for (const [index, method] of [...objects, ...primitives].entries()) {
      select.mockResolvedValue(selected);
      const input = {
        cwd: "/workspace",
        executionTargetId: "ssh:fixture",
        operationId: `origin-${index}`,
      };
      const args = objects.includes(method)
        ? [input]
        : method === "commit"
          ? [input.cwd, "subject", "body", input]
          : [
              input.cwd,
              ...(["prepareCommitContext", "pushCurrentBranch"].includes(method)
                ? [undefined]
                : []),
              input.executionTargetId,
              input.operationId,
            ];
      await Effect.runPromise(
        (git[method as keyof GitCoreShape] as (...args: unknown[]) => Effect.Effect<unknown>)(
          ...args,
        ),
      );
    }
    expect(routes).toEqual(Array.from({ length: 34 }, () => "original"));
    await expect(Effect.runPromise(git.fetch("/workspace", "ssh:fixture"))).rejects.toThrow(
      "original durable action identity",
    );
    expect(routes).toHaveLength(34);
  } finally {
    await local.dispose();
    vi.restoreAllMocks();
  }
});
