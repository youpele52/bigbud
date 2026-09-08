import { describe, expect, it } from "vitest";

import { parseWorktreeBranchPaths } from "./GitBranches.list.ts";

describe("parseWorktreeBranchPaths", () => {
  it("keeps remote-only worktree paths and omits prunable records", () => {
    const result = parseWorktreeBranchPaths(
      [
        "worktree /srv/project",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /srv/project-feature",
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/feature/remote",
        "",
        "worktree /srv/stale-worktree",
        "HEAD 3333333333333333333333333333333333333333",
        "branch refs/heads/feature/stale",
        "prunable gitdir file points to non-existent location",
        "",
      ].join("\n"),
    );

    expect(result).toEqual(
      new Map([
        ["main", "/srv/project"],
        ["feature/remote", "/srv/project-feature"],
      ]),
    );
  });
});
