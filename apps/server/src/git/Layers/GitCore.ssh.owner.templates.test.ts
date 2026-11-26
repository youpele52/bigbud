import { Effect, Path } from "effect";
import { describe, expect, it, vi } from "vitest";

import { WireWriter } from "../../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { writeWorkspaceGit } from "../../ssh/sshOwnerPickerProof.codec.git.ts";
import { proofRequestPolicy } from "../../ssh/sshOwnerPickerProof.client.requestPolicy.ts";
import type { ExecuteGitResult } from "../Services/GitCore.ts";
import { makeRemoteGitOps } from "./GitCore.remoteOps.ts";
import type { DirectWorkspaceGitTemplateRequest } from "./GitCore.ssh.owner.ts";
import { TEMPLATE_ACTION_TAGS, selectTemplate } from "./GitCore.ssh.owner.templates.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";

const targetId = "ssh:host=example&transport=direct-ssh";
const cwd = "/srv/project";

const refuse = async (): Promise<ExecuteGitResult> => {
  throw new Error("not a template request");
};

/** Drive the real remote Git ops; the fake owner answers per action and records the calls. */
function harness(
  answer: (request: DirectWorkspaceGitTemplateRequest) => Partial<ExecuteGitResult>,
) {
  const calls: Array<{ action: string; operands: ReadonlyArray<string> }> = [];
  const execute = vi.fn(async (request: DirectWorkspaceGitTemplateRequest) => {
    calls.push({ action: request.action, operands: request.operands });
    return {
      code: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      ...answer(request),
    };
  });
  const git = makeSshGitExecutor({ execute: refuse, template: { execute } });
  const ops = Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* (yield* makeRemoteGitOps(git, path, "/unused"))(targetId);
  }).pipe(Effect.provide(Path.layer));
  return { calls, ops };
}

describe("direct SSH branch, commit, worktree and range Git (B)", () => {
  it("issues the owner templates for the product's own argv", async () => {
    const { calls, ops } = harness((request) =>
      request.action === "currentBranch"
        ? { stdout: "feature/y\n" }
        : request.action === "revParseHead"
          ? { stdout: "a".repeat(40) + "\n" }
          : request.action === "showRefHead"
            ? { code: 1 }
            : {},
    );
    await Effect.runPromise(
      ops.pipe(
        Effect.flatMap(({ statusOps, branchOps, worktreeOps }) =>
          Effect.gen(function* () {
            yield* branchOps.createBranch({ cwd, branch: "feature/x" });
            yield* branchOps.renameBranch({ cwd, oldBranch: "feature/x", newBranch: "feature/y" });
            yield* statusOps.commit(cwd, "feat: subject", "body");
            yield* statusOps.readRangeContext(cwd, "main");
            yield* worktreeOps.createWorktree({
              cwd,
              branch: "main",
              newBranch: "wt",
              path: "/srv/project-wt",
            });
            yield* worktreeOps.removeWorktree({ cwd, path: "/srv/project-wt", force: true });
          }),
        ),
      ),
    );
    const sequence = calls.map(({ action }) => action);
    expect(sequence).toEqual(
      expect.arrayContaining([
        "branchCreate",
        "branchRename",
        "commitWithBody",
        "revParseHead",
        "rangeLog",
        "rangeDiffStat",
        "rangeDiffPatch",
        "worktreeAddNewBranch",
        "worktreeRemoveForce",
      ]),
    );
    expect(calls).toContainEqual({ action: "commitWithBody", operands: ["feat: subject", "body"] });
    expect(calls).toContainEqual({ action: "rangeLog", operands: ["main..HEAD"] });
    expect(calls).toContainEqual({
      action: "worktreeAddNewBranch",
      operands: ["wt", "/srv/project-wt", "main"],
    });
  });

  it("refuses option-shaped operands and mismatched caps before the owner", () => {
    const pick = (args: string[], extra = {}) =>
      selectTemplate({
        operation: "GitCore.any",
        cwd,
        args,
        allowNonZeroExit: true,
        ...extra,
      });
    expect(pick(["checkout", "--orphan"])).toBeUndefined();
    expect(pick(["checkout", "main", "--", "x"])).toBeUndefined();
    expect(pick(["log", "--oneline", "main..HEAD"])).toBeUndefined();
    expect(
      pick(["log", "--oneline", "main..HEAD"], {
        maxOutputBytes: 19_000,
        truncateOutputAtMaxBytes: true,
      }),
    ).toEqual({ action: "rangeLog", operands: ["main..HEAD"], capped: true });
    expect(pick(["add", "-A", "--", "a.txt", "b/c.txt"])).toMatchObject({
      action: "addSelected",
      operands: ["a.txt", "b/c.txt"],
    });
    expect(pick(["branch", "x"], { env: { GIT_DIR: "/x" } })).toBeUndefined();
  });

  it("encodes tags 26-58 with operands and waits for long mutations", () => {
    expect(Object.values(TEMPLATE_ACTION_TAGS)).toEqual(
      Array.from({ length: 49 }, (_, index) => 26 + index),
    );
    const writer = new WireWriter();
    writeWorkspaceGit(writer, {
      kind: "proofWorkspaceGit",
      workspaceRoot: cwd,
      action: "commit",
      operands: ["msg"],
    });
    const hex = Buffer.from(writer.finish()).toString("hex");
    expect(hex).toContain("102e"); // action 46
    expect(hex).toContain(`4203${Buffer.from("msg").toString("hex")}`);
    const policy = (action: string) =>
      proofRequestPolicy({
        kind: "proofWorkspaceGit",
        workspaceRoot: cwd,
        action: action as "commit",
      }).replyTimeout;
    expect(policy("commit")).toBe(125_000);
    expect(policy("rangeLog")).toBe("workspace");
    expect(policy("stashList")).toBe("workspace");
    expect(policy("stashPop")).toBe(125_000);
    expect(policy("branchForceDelete")).toBe(125_000);
  });

  it("maps stash, force delete, new branch, init, remote add and worktree creation", () => {
    const pick = (args: string[]) =>
      selectTemplate({ operation: "GitCore.any", cwd, args, allowNonZeroExit: true });
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(pick(["branch", "-D", "--", "topic"])).toMatchObject({ action: "branchForceDelete" });
    expect(pick(["checkout", "-b", "topic", sha])).toMatchObject({
      action: "checkoutNewBranchFrom",
      operands: ["topic", sha],
    });
    expect(pick(["stash", "pop", "stash@{2}"])).toMatchObject({ action: "stashPopRef" });
    expect(pick(["stash", "pop", "HEAD"])).toBeUndefined();
    expect(pick(["init"])).toMatchObject({ action: "init" });
    expect(pick(["remote", "add", "up", "ext::sh"])).toBeUndefined();
    expect(pick(["worktree", "add", "-b", "wt", "--", "/srv/project-wt", sha])).toMatchObject({
      action: "worktreeAddNewBranchAt",
      operands: ["wt", "/srv/project-wt", sha],
    });
  });
});
