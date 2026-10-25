import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandId, ThreadId, ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  createRuntime,
  engineFor,
} from "../../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { makeIsolatedGitCore } from "./GitCore.test.helpers.ts";
import { makeWorktreeLifecycle } from "./WorktreeLifecycle.ts";
import { worktreeFailure } from "./WorktreeInventory.ts";

const execute = promisify(execFile);

/** Real Git and canonical event-sourced engine, with faults confined to temporary resources. */
export async function worktreeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "bigbud-worktree-lifecycle-"));
  const repo = path.join(root, "repo"),
    worktree = path.join(root, "trees", "physical-name");
  const control: {
    loseAddAck?: boolean;
    loseRemoveAck?: boolean;
    beforeAdd?: () => Promise<void>;
  } = {};
  await mkdir(repo);
  const git = (args: string[]) => execute("git", args, { cwd: repo });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await writeFile(path.join(repo, "README.md"), "test\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  await git(["worktree", "add", "-b", "different-branch", worktree]);
  const runtime = createRuntime(path.join(root, "test.sqlite"));
  const engine = await engineFor(runtime);
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const core = await Effect.runPromise(
    makeIsolatedGitCore((input) =>
      Effect.tryPromise({
        try: async () => {
          if (input.args[0] === "worktree" && input.args[1] === "add") await control.beforeAdd?.();
          const result = await execute("git", [...input.args], {
            cwd: input.cwd,
            maxBuffer: 8 * 1024 * 1024,
          })
            .then((result) => ({ ...result, code: 0 }))
            .catch((cause: unknown) => {
              if (
                input.allowNonZeroExit &&
                cause &&
                typeof cause === "object" &&
                "code" in cause &&
                typeof cause.code === "number" &&
                "stdout" in cause &&
                "stderr" in cause
              )
                return {
                  code: cause.code,
                  stdout: String(cause.stdout),
                  stderr: String(cause.stderr),
                };
              throw cause;
            });
          if (input.args[0] === "worktree" && input.args[1] === "add" && control.loseAddAck) {
            control.loseAddAck = false;
            throw new Error("Lost add acknowledgement");
          }
          if (input.args[0] === "worktree" && input.args[1] === "remove" && control.loseRemoveAck) {
            control.loseRemoveAck = false;
            throw new Error("Lost remove acknowledgement");
          }
          return {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        },
        catch: (cause) => worktreeFailure(input.cwd, String(cause), cause),
      }),
    ),
  );
  const service = makeWorktreeLifecycle({
    sql,
    git: core,
    engine,
    worktreesDir: path.join(root, "trees"),
  });
  const projectId = ProjectId.makeUnsafe("project");
  await runtime.runPromise(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("project-create"),
      projectId,
      title: "Project",
      workspaceRoot: repo,
      defaultModelSelection: { provider: "codex", model: "test" },
      createdAt: new Date().toISOString(),
    }),
  );
  const addThread = async (
    name: string,
    provider: "codex" | "opencodeV2" | "claudeAgent" | "pi" = "codex",
    worktreePath = worktree,
  ) => {
    const threadId = ThreadId.makeUnsafe(name);
    await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`create-${name}`),
        projectId,
        threadId,
        title: name,
        modelSelection: { provider, model: "test" },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "different-branch",
        worktreePath,
        createdAt: new Date().toISOString(),
      }),
    );
    return threadId;
  };
  const request = async () => {
    const entry = (await runtime.runPromise(service.inventory({ cwd: repo }))).entries.find(
      (candidate) => !candidate.main,
    )!;
    return {
      cwd: repo,
      path: worktree,
      expectedIdentity: entry.identity!,
      expectedHead: entry.head,
      expectedBranch: entry.branch,
      operationId: crypto.randomUUID(),
    };
  };
  return {
    root,
    repo,
    worktree,
    runtime,
    engine,
    sql,
    core,
    service,
    addThread,
    request,
    git,
    control,
    dispose: async () => {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
