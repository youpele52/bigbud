import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { configureRemoteAgentOwners } from "./remoteAgentOwners.ts";
import {
  RemoteAgentGitActionBinding,
  reserveRemoteAgentGitAction,
} from "./remoteAgentGit.action.ts";
import { makeRunStackedActionStep } from "../git/Layers/GitManager.runStackedAction.ts";
import { installManagerFixture, installInput } from "./remoteAgentInstallManager.fixtures.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import * as Control from "./remoteAgentControl.ts";
import * as RemoteDefault from "./remoteAgentDefault.ts";
import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import { currentRemoteAgentController } from "./remoteAgentController.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";

afterEach(() => vi.restoreAllMocks());

it("pins a whole stacked action across commit/push activation and server-store restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bigbud-git-action-"));
  const fixture = installManagerFixture();
  await fixture.manager.install(installInput);
  const build = (await fixture.control.registry.read()).builds[0]!;
  const old = { runtime: build.runtime, expectedEpoch: "old-epoch", connectionId: "old" };
  const select = vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(old);
  vi.spyOn(Control, "openRemoteAgentControl").mockResolvedValue(fixture.control);
  vi.spyOn(RemoteDefault, "getConfiguredRemoteAgentComposition").mockReturnValue({} as never);
  const observed: string[] = [];
  let pushes = 0;
  const actionInput = {
    actionId: "whole-action",
    action: "commit_push" as const,
    cwd: "/workspace",
    executionTargetId: "ssh:fixture",
  };
  try {
    for (let restart = 0; restart < 2; restart++) {
      const runtime = ManagedRuntime.make(
        NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
      );
      try {
        if (!restart) await runtime.runPromise(Effect.andThen(OwnersMigration, ReplayMigration));
        configureRemoteAgentOwners(await runtime.runPromise(makeRemoteAgentRuntimeBindings));
        const manager = makeRunStackedActionStep({
          gitCore: {
            statusDetails: () =>
              Effect.succeed({ branch: "main", hasUpstream: true, aheadCount: 1 }),
            pushCurrentBranch: () =>
              Effect.gen(function* () {
                observed.push((yield* RemoteAgentGitActionBinding).connectionId!);
                if (pushes++ === 0)
                  return yield* new GitCommandError({
                    operation: "push",
                    command: "git push",
                    cwd: "/workspace",
                    detail: "lost response",
                  });
                return { status: "pushed", branch: "main" };
              }),
          } as never,
          commitStep: {
            runCommitStep: () =>
              Effect.gen(function* () {
                observed.push((yield* RemoteAgentGitActionBinding).connectionId!);
                select.mockResolvedValue({
                  ...old,
                  connectionId: "new",
                  expectedEpoch: "new-epoch",
                });
                return { status: "created", commitSha: "commit" };
              }),
          } as never,
          serverSettingsService: { getSettings: Effect.succeed({}) } as never,
          prLookup: { buildCompletionToast: () => Effect.succeed({}) } as never,
          prStep: {} as never,
          invalidateStatus: () => Effect.void,
        });
        const run = Effect.runPromise(manager.runStackedAction(actionInput));
        if (!restart) await expect(run).rejects.toThrow("lost response");
        else await expect(run).resolves.toMatchObject({ push: { status: "pushed" } });
      } finally {
        await runtime.dispose();
      }
    }
    expect(select).toHaveBeenCalledOnce();
    expect(observed).toEqual(["old", "old", "old", "old"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("reclaims a crashed pre-dispatch action but never replaces a live prepared action", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bigbud-git-action-recovery-"));
  const fixture = installManagerFixture();
  await fixture.manager.install(installInput);
  const build = (await fixture.control.registry.read()).builds[0]!;
  const binding = {
    runtime: build.runtime,
    expectedEpoch: "epoch-1",
    connectionId: "connection-1",
  };
  const select = vi.spyOn(remoteAgentAdmission, "resolveBinding").mockResolvedValue(binding);
  vi.spyOn(Control, "openRemoteAgentControl").mockResolvedValue(fixture.control);
  const controller = currentRemoteAgentController();
  const request = { action: "commit_push", cwd: "/workspace" };
  const digest = Buffer.from(remoteAgentRequestDigest(request)).toString("hex");
  const runtime = ManagedRuntime.make(
    NodeSqlite.layer({ filename: join(directory, "owners.sqlite") }),
  );
  try {
    await runtime.runPromise(Effect.andThen(OwnersMigration, ReplayMigration));
    const store = await runtime.runPromise(makeRemoteAgentRuntimeBindings);
    configureRemoteAgentOwners(store);
    await store.reserve({
      ownerKey: "git-action:crashed",
      invocationId: "crashed",
      resourceId: "crashed",
      target: "ssh:fixture",
      connectionId: binding.connectionId,
      runtime: binding.runtime,
      epoch: binding.expectedEpoch,
      digest,
      controllerId: "controller:dead",
      controllerPid: 99_999_999,
      controllerStartedAt: "dead-start",
      state: "prepared",
      outputSequence: 0,
      nextInputSequence: 1,
      inputAcknowledged: 0,
    });
    await reserveRemoteAgentGitAction("ssh:fixture", "crashed", request);
    expect((await store.get("git-action:crashed"))?.controllerId).toBe(controller.id);

    await store.reserve({
      ownerKey: "git-action:live",
      invocationId: "live",
      resourceId: "live",
      target: "ssh:fixture",
      connectionId: binding.connectionId,
      runtime: binding.runtime,
      epoch: binding.expectedEpoch,
      digest: Buffer.from(remoteAgentRequestDigest({ action: "live" })).toString("hex"),
      controllerId: controller.id,
      controllerPid: controller.pid,
      controllerStartedAt: controller.startedAt,
      state: "prepared",
      outputSequence: 0,
      nextInputSequence: 1,
      inputAcknowledged: 0,
    });
    await Promise.all([
      reserveRemoteAgentGitAction("ssh:fixture", "live", { action: "live" }),
      reserveRemoteAgentGitAction("ssh:fixture", "live", { action: "live" }),
    ]);
    expect(select).toHaveBeenCalledOnce();
    expect((await store.get("git-action:live"))?.controllerId).toBe(controller.id);
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
