import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { WireWriter } from "../../remote-agent/remoteAgentProtocol.codec.wire.ts";
import { writeWorkspaceGit } from "../../ssh/sshOwnerPickerProof.codec.git.ts";
import type { PickerProofWorkspaceGitInput } from "../../ssh/sshOwnerPickerProof.codec.git.ts";
import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import type { ExecuteGitInput } from "../Services/GitCore.ts";
import { makeProductionWorkspaceGitOwner } from "./GitCore.ssh.owner.production.ts";
import { selectDiffRead } from "./GitCore.ssh.owner.reads.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";

const targetId = "ssh:host=example&transport=direct-ssh";
const cwd = "/srv/repo";
const base = { executionTargetId: targetId, cwd, allowNonZeroExit: true } as const;

function liveOwner() {
  const executeProofWorkspaceGit = vi.fn(async (_input: PickerProofWorkspaceGitInput) => ({
    code: 0,
    stdout: "diff --git a/a b/a\n",
    stderr: "",
  }));
  const descriptorFor = vi.fn(async (_id: string) => ({ targetId: _id }));
  const target = vi.fn((_descriptor: unknown) => ({ executeProofWorkspaceGit }));
  const registration = {
    handle: { target, state: () => "open" },
    descriptorFor,
  } as unknown as SshOwnerProductionRegistration;
  return { registration, executeProofWorkspaceGit, descriptorFor, target };
}

describe("production direct workspace Git (C06)", () => {
  it("resolves the exact target per call and sends the fixed diff recipe with the root", async () => {
    const live = liveOwner();
    const git = makeSshGitExecutor(makeProductionWorkspaceGitOwner(() => live.registration));
    const result = await Effect.runPromise(
      git({
        ...base,
        operation: "GitCore.readWorkingTreeDiff.initial.unstaged",
        args: ["diff", "--find-renames", "--", "src/a.ts"],
      }),
    );
    expect(result.stdout).toBe("diff --git a/a b/a\n");
    expect(live.descriptorFor).toHaveBeenCalledWith(targetId);
    expect(live.executeProofWorkspaceGit).toHaveBeenCalledExactlyOnceWith({
      action: "diffUnstaged",
      workspaceRoot: cwd,
      executionTargetId: targetId,
      paths: ["src/a.ts"],
    });
  });

  it("serves status, branch list and untracked file diff; refuses everything else", async () => {
    const live = liveOwner();
    const git = makeSshGitExecutor(makeProductionWorkspaceGitOwner(() => live.registration));
    await Effect.runPromise(
      git({
        ...base,
        operation: "GitCore.statusDetails.status",
        args: ["status", "--porcelain=2", "--branch", "-uall"],
      }),
    );
    await Effect.runPromise(
      git({
        ...base,
        operation: "GitCore.listLocalBranchNames",
        args: ["branch", "--list", "--no-column", "--format=%(refname:short)"],
      }),
    );
    await Effect.runPromise(
      git({
        ...base,
        operation: "GitCore.readWorkingTreeDiff.untrackedFile",
        args: ["diff", "--no-index", "/dev/null", "new.txt"],
      }),
    );
    expect(live.executeProofWorkspaceGit.mock.calls.map(([input]) => input.action)).toEqual([
      "statusPorcelainV2",
      "localBranches",
      "untrackedFileDiff",
    ]);
    const refused = await Effect.runPromise(
      Effect.flip(git({ ...base, operation: "GitCore.listCommits", args: ["log", "-n", "5"] })),
    );
    expect(refused.detail).toContain("not supported by the direct workspace Git owner");
    expect(live.executeProofWorkspaceGit).toHaveBeenCalledTimes(3);
  });

  it("refuses typed without an open owner and starts nothing", async () => {
    const git = makeSshGitExecutor(makeProductionWorkspaceGitOwner(() => undefined));
    const error = await Effect.runPromise(
      Effect.flip(
        git({
          ...base,
          operation: "GitCore.statusDetails.status",
          args: ["status", "--porcelain=2", "--branch", "-uall"],
        }),
      ),
    );
    expect(error.detail).toBe("The direct workspace Git owner could not complete the request.");
  });
});

describe("diff-read selection", () => {
  const input = (operation: string, args: string[], extra: Partial<ExecuteGitInput> = {}) =>
    selectDiffRead({ ...base, operation, args, ...extra });

  it("matches exact argv with at most the declared paths", () => {
    expect(input("GitCore.readWorkingTreeDiff.hasHead", ["rev-parse", "--verify", "HEAD"])).toEqual(
      {
        action: "hasHead",
        paths: [],
      },
    );
    expect(
      input("GitCore.readWorkingTreeDiff.trackedAgainstHead", [
        "diff",
        "--find-renames",
        "HEAD",
        "--",
      ]),
    ).toEqual({ action: "diffAgainstHead", paths: [] });
    expect(
      input("GitCore.readWorkingTreeDiff.status", [
        "status",
        "--porcelain=1",
        "--untracked-files=all",
        "--",
        "a",
        "b",
      ]),
    ).toBeUndefined();
    expect(
      input("GitCore.readWorkingTreeDiff.initial.staged", [
        "diff",
        "--cached",
        "--find-renames",
        "--",
        "../x",
      ]),
    ).toBeUndefined();
    expect(
      input("GitCore.readWorkingTreeDiff.untrackedFile", ["diff", "--no-index", "/dev/null"]),
    ).toBeUndefined();
    expect(
      input("GitCore.readWorkingTreeDiff.hasHead", ["rev-parse", "--verify", "HEAD"], {
        env: { GIT_DIR: "/x" },
      }),
    ).toBeUndefined();
  });

  it("encodes the production action tags 13-19", () => {
    const tags = [
      "diffStatus",
      "hasHead",
      "diffAgainstHead",
      "diffStaged",
      "diffUnstaged",
      "untrackedFileDiff",
      "localBranches",
    ] as const;
    for (const [index, action] of tags.entries()) {
      const writer = new WireWriter();
      writeWorkspaceGit(writer, { kind: "proofWorkspaceGit", workspaceRoot: cwd, action });
      expect(Buffer.from(writer.finish()).toString("hex")).toContain(
        `10${(13 + index).toString(16).padStart(2, "0")}`,
      );
    }
  });
});
