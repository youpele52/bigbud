import { describe, expect, it } from "vitest";

import { buildTemporaryWorktreeBranchName, isTemporaryWorktreeBranch } from "./git";

describe("buildTemporaryWorktreeBranchName", () => {
  it("reuses the same physical branch identity for the same recovery seed", () => {
    const first = buildTemporaryWorktreeBranchName("command-recovery-1");
    const retry = buildTemporaryWorktreeBranchName("command-recovery-1");
    const other = buildTemporaryWorktreeBranchName("command-recovery-2");

    expect(retry).toBe(first);
    expect(other).not.toBe(first);
    expect(isTemporaryWorktreeBranch(first)).toBe(true);
  });
});
