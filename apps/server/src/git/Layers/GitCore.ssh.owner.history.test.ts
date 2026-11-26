import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ExecuteGitInput, ExecuteGitResult } from "../Services/GitCore.ts";
import { selectHistoryRead } from "./GitCore.ssh.owner.history.ts";
import type { DirectWorkspaceGitHistoryRequest } from "./GitCore.ssh.owner.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";
import {
  COMMIT_FILE_DIFF_ARGS,
  COMMIT_NUMSTAT_ARGS,
  COMMIT_SUMMARY_FORMAT,
} from "./GitHistory.commit.ts";
import { COMMIT_LOG_FORMAT } from "./GitHistory.parse.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";
const base = {
  executionTargetId: "ssh:host=example&transport=direct-ssh",
  cwd: "/srv/repo",
  allowNonZeroExit: true,
} as const;
const fileDiff: ExecuteGitInput = {
  ...base,
  operation: "GitCore.getCommitFileDiff",
  args: [...COMMIT_FILE_DIFF_ARGS, sha, "--", ":(top,literal)old.txt", ":(top,literal)new.txt"],
  maxOutputBytes: 1_000,
  truncateOutputAtMaxBytes: true,
};

const refuse = async (): Promise<ExecuteGitResult> => {
  throw new Error("unused");
};

describe("History panel owner reads", () => {
  it("maps each exact product read to one recipe with validated operands", () => {
    const pick = (operation: string, args: string[]) =>
      selectHistoryRead({ ...base, operation, args });
    expect(
      pick("GitCore.listCommits", ["log", "--max-count=21", "--skip=20", COMMIT_LOG_FORMAT]),
    ).toEqual({ action: "commitLog", paths: [], limit: 21, skip: 20 });
    expect(
      pick("GitCore.listCommits.upstreamRef", [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]),
    ).toEqual({ action: "upstreamRef", paths: [] });
    expect(pick("GitCore.listCommits.unpushed", ["rev-list", "origin/main..HEAD"])).toEqual({
      action: "unpushedShas",
      paths: [],
      revision: "origin/main",
    });
    expect(
      pick("GitCore.getCommitDetails.summary", ["show", "-s", COMMIT_SUMMARY_FORMAT, sha]),
    ).toMatchObject({ action: "commitSummary", revision: sha });
    expect(
      pick("GitCore.getCommitDetails.numstat", [...COMMIT_NUMSTAT_ARGS, sha, "--"]),
    ).toMatchObject({ action: "commitNumstat", revision: sha });
    expect(selectHistoryRead(fileDiff)).toEqual({
      action: "commitFileDiff",
      paths: ["old.txt", "new.txt"],
      revision: sha,
      maxOutputBytes: 1_000,
    });
  });

  it("refuses anything outside the exact recipes", () => {
    const pick = (operation: string, args: string[]) =>
      selectHistoryRead({ ...base, operation, args });
    expect(
      pick("GitCore.listCommits", ["log", "--max-count=500", COMMIT_LOG_FORMAT]),
    ).toBeUndefined();
    expect(pick("GitCore.listCommits.unpushed", ["rev-list", "--all..HEAD"])).toBeUndefined();
    expect(
      pick("GitCore.getCommitDetails.summary", ["show", "-s", COMMIT_SUMMARY_FORMAT, "HEAD"]),
    ).toBeUndefined();
    expect(selectHistoryRead({ ...fileDiff, maxOutputBytes: 5_000_000 })).toBeUndefined();
    expect(
      selectHistoryRead({ ...fileDiff, args: [...COMMIT_FILE_DIFF_ARGS, sha, "--", "plain.txt"] }),
    ).toBeUndefined();
  });

  it("passes a capped file diff through as truncated instead of failing", async () => {
    const execute = vi.fn(
      async (_request: DirectWorkspaceGitHistoryRequest): Promise<ExecuteGitResult> => ({
        code: 0,
        stdout: "x".repeat(1_000),
        stderr: "",
        stdoutTruncated: true,
        stderrTruncated: false,
      }),
    );
    const git = makeSshGitExecutor({ execute: refuse, history: { execute } });
    const result = await Effect.runPromise(git(fileDiff));
    expect(result.stdoutTruncated).toBe(true);
    expect(execute.mock.calls[0]![0]).toMatchObject({ revision: sha, maxOutputBytes: 1_000 });
  });
});
