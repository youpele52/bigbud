import type { OrchestrationReadModel, TerminalOpenInput } from "@bigbud/contracts";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import { TerminalLimitError } from "@bigbud/contracts/workspace/terminal.limit.ts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { bootstrapSetupFailureDetail } from "../../ws/wsBootstrap.setup.ts";
import { ProjectSetupScriptRunner } from "../Services/ProjectSetupScriptRunner.ts";
import {
  PENDING_SETUP_MAX_ENTRIES,
  PENDING_SETUP_TTL_MS,
  PendingProjectSetups,
} from "./ProjectSetupScriptRunner.pending.ts";
import { ProjectSetupScriptRunnerLive } from "./ProjectSetupScriptRunner.ts";

const candidate = {
  threadId: "t-old",
  terminalId: "old",
  lastUsedAt: "2026-11-21T09:00:00.000Z",
  busy: false,
};
const limitError = () => new TerminalLimitError({ limit: 24, liveCount: 24, candidate });

function readModel(threads: ReadonlyArray<{ id: string; worktreePath: string | null }>) {
  return {
    projects: [
      {
        id: "project-1",
        workspaceRoot: "/repo/project",
        scripts: [
          {
            id: "setup",
            name: "Setup",
            command: "bun install",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ],
      },
    ],
    threads: threads.map((thread) => ({ ...thread, projectId: "project-1" })),
  } as unknown as OrchestrationReadModel;
}

async function setup(input: {
  refusals: number;
  threads?: Array<{ id: string; worktreePath: string | null }>;
}) {
  let refusals = input.refusals;
  const opens: TerminalOpenInput[] = [];
  const notices: TerminalLifecycleNotice[] = [];
  const terminal = {
    snapshot: () => Effect.die("unused"),
    listShellProfiles: () => Effect.die("unused"),
    open: (open: TerminalOpenInput) => {
      opens.push(open);
      if (refusals-- > 0) return Effect.fail(limitError());
      return Effect.succeed({
        threadId: open.threadId,
        terminalId: open.terminalId,
        executionTargetId: "local",
        runtimeEnv: open.env,
        dropPathMode: "posix",
        cwd: open.cwd,
        worktreePath: open.worktreePath,
        status: "running",
        pid: 1,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    },
    write: () => Effect.void,
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die("unused"),
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    publishLifecycleNotice: (notice: TerminalLifecycleNotice) =>
      Effect.sync(() => void notices.push(notice)),
  };
  const runner = await Effect.runPromise(
    Effect.service(ProjectSetupScriptRunner).pipe(
      Effect.provide(
        ProjectSetupScriptRunnerLive.pipe(
          Layer.provideMerge(
            Layer.succeed(OrchestrationEngineService, {
              getReadModel: () => Effect.succeed(readModel(input.threads ?? [])),
              readEvents: () => Stream.empty,
              readReplay: () => Effect.die("unused replay"),
              dispatch: () => Effect.die(new Error("unused")),
              streamDomainEvents: Stream.empty,
            }),
          ),
          Layer.provideMerge(Layer.succeed(TerminalManager, terminal as never)),
        ),
      ),
    ),
  );
  return { runner, opens, notices };
}

const run = { threadId: "thread-1", projectId: "project-1", worktreePath: "/repo/worktrees/a" };
const evict = { threadId: "t-old", terminalId: "old" };

describe("setup scripts at the live terminal limit", () => {
  it("raises the setup toast and fails, so a dismissed toast marks the setup failed", async () => {
    const { runner, notices } = await setup({ refusals: 1 });
    const failure = await Effect.runPromise(runner.runForThread(run).pipe(Effect.flip));
    expect(failure).toBeInstanceOf(TerminalLimitError);
    expect(notices).toEqual([
      expect.objectContaining({
        kind: "setupBlockedByLimit",
        threadId: "thread-1",
        candidate,
        limit: 24,
      }),
    ]);
    expect(bootstrapSetupFailureDetail(failure)).toBe(
      "Setup script didn't run because the terminal limit (24) is reached. Close a terminal and run it again.",
    );
  });

  it("retries with the stored inputs, closing the confirmed candidate first", async () => {
    const { runner, opens } = await setup({ refusals: 1 });
    await Effect.runPromise(runner.runForThread(run).pipe(Effect.flip));
    const result = await Effect.runPromise(
      runner.retryBlockedSetup!({ threadId: "thread-1", evict }),
    );
    expect(result).toMatchObject({ status: "started", scriptId: "setup" });
    expect(opens.at(-1)).toMatchObject({
      terminalId: "setup-setup",
      cwd: "/repo/worktrees/a",
      evict,
    });
  });

  it("re-derives the inputs from the thread when none are stored (restart or expiry)", async () => {
    const { runner, opens } = await setup({
      refusals: 0,
      threads: [{ id: "thread-1", worktreePath: "/repo/worktrees/b" }],
    });
    const result = await Effect.runPromise(
      runner.retryBlockedSetup!({ threadId: "thread-1", evict }),
    );
    expect(result).toMatchObject({ status: "started" });
    expect(opens.at(-1)).toMatchObject({ cwd: "/repo/worktrees/b", evict });
  });

  it("fails with guidance when the inputs are gone", async () => {
    const { runner } = await setup({
      refusals: 0,
      threads: [{ id: "thread-1", worktreePath: null }],
    });
    const failure = await Effect.runPromise(
      runner.retryBlockedSetup!({ threadId: "thread-1", evict }).pipe(Effect.flip),
    );
    expect(failure.message).toBe(
      "The setup inputs are no longer available. Run the setup script again from the project menu.",
    );
  });
});

describe("pending setup map", () => {
  it("is bounded to 64 entries and forgets entries after 30 minutes", () => {
    let now = 0;
    const pending = new PendingProjectSetups(() => now);
    const entry = { input: run, cwd: "/w", env: {}, scriptId: "setup" };
    for (let index = 0; index < PENDING_SETUP_MAX_ENTRIES + 5; index++)
      pending.remember(`thread-${index}`, entry);
    expect(pending.size).toBe(PENDING_SETUP_MAX_ENTRIES);
    expect(pending.take("thread-0")).toBeUndefined();
    expect(pending.take("thread-10")).toMatchObject({ scriptId: "setup" });
    now = PENDING_SETUP_TTL_MS + 1;
    expect(pending.take("thread-20")).toBeUndefined();
  });
});
