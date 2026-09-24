import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  managedWorktreeRelativePath,
  recordedWorktreePathsOverlap,
} from "./ThreadDeletion.worktreePaths.ts";

describe("managed worktree path rules", () => {
  it("classifies macOS and Linux POSIX paths without traversing external directories", () => {
    expect(
      managedWorktreeRelativePath("/state/worktrees", "/state/worktrees/one", path.posix),
    ).toBe("one");
    expect(managedWorktreeRelativePath("/state/worktrees", "/project/one", path.posix)).toBeNull();
    expect(() =>
      managedWorktreeRelativePath("/state/worktrees", "/state/worktrees", path.posix),
    ).toThrow("unsafe managed worktree path");
    expect(() =>
      managedWorktreeRelativePath("/state/worktrees", "/state/worktrees/../outside", path.posix),
    ).toThrow("unsafe managed worktree path");
    expect(
      recordedWorktreePathsOverlap(
        "/state/worktrees/one",
        "/state/worktrees/one/child",
        path.posix,
      ),
    ).toBe(true);
    expect(recordedWorktreePathsOverlap("/state/worktrees/one", "/other/one", path.posix)).toBe(
      false,
    );
  });

  it("uses Windows drive and case rules for ownership and overlap", () => {
    expect(
      managedWorktreeRelativePath("C:\\State\\worktrees", "c:\\state\\worktrees\\one", path.win32),
    ).toBe("one");
    expect(
      managedWorktreeRelativePath("C:\\State\\worktrees", "D:\\project\\one", path.win32),
    ).toBeNull();
    expect(() =>
      managedWorktreeRelativePath(
        "C:\\State\\worktrees",
        "c:\\state\\worktrees\\..\\outside",
        path.win32,
      ),
    ).toThrow("unsafe managed worktree path");
    expect(
      recordedWorktreePathsOverlap(
        "C:\\State\\worktrees\\one",
        "c:\\state\\worktrees\\ONE\\child",
        path.win32,
      ),
    ).toBe(true);
    expect(
      recordedWorktreePathsOverlap(
        "C:\\State\\worktrees\\one",
        "D:\\state\\worktrees\\one",
        path.win32,
      ),
    ).toBe(false);
  });
});
