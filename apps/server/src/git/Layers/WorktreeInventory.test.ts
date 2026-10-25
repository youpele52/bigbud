import { describe, expect, it } from "vitest";
import { parseWorktreeInventory } from "./WorktreeInventory.ts";
import { makeWorktreeInventory } from "./WorktreeInventory.ts";
import { Effect } from "effect";

describe("complete worktree inventory", () => {
  it("does not mistake a POSIX backslash in a physical folder name for a separator", () => {
    expect(
      parseWorktreeInventory("worktree /trees/folder\\name\0HEAD abc\0detached\0\0")[0]?.name,
    ).toBe("folder\\name");
    expect(
      parseWorktreeInventory("worktree C:\\trees\\folder\0HEAD abc\0detached\0\0")[0]?.name,
    ).toBe("folder");
  });
  it("keeps remote observations target-routed and never attaches host filesystem identity", async () => {
    const targets: (string | undefined)[] = [];
    const listing = await Effect.runPromise(
      makeWorktreeInventory({
        execute: (input) => {
          targets.push(input.executionTargetId);
          return Effect.succeed({
            code: 0,
            stdout:
              input.args[0] === "rev-parse"
                ? "/srv/repo/.git\n"
                : "worktree /srv/repo\0HEAD abc\0branch refs/heads/main\0\0worktree /srv/folder\0HEAD def\0branch refs/heads/different\0\0",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      })({ cwd: "/srv/repo", executionTargetId: "ssh:fixture", selectedPath: "/srv/folder" }),
    );
    expect(targets).toEqual(["ssh:fixture", "ssh:fixture"]);
    expect(listing).toMatchObject({
      local: false,
      repository: "/srv/repo/.git",
      linkedCount: 1,
      selectedPath: "/srv/folder",
    });
    expect(listing.entries.every((entry) => entry.identity === undefined)).toBe(true);
  });
  it("preserves spaces and newlines and distinguishes physical names from branches", () => {
    const entries = parseWorktreeInventory(
      "worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /trees/a\nb \0HEAD def\0branch refs/heads/feature\0locked maintenance\0\0",
    );
    expect(entries[0]).toMatchObject({ main: true, branch: "main" });
    expect(entries[1]).toMatchObject({
      main: false,
      name: "a\nb ",
      branch: "feature",
      path: "/trees/a\nb ",
      locked: "maintenance",
    });
  });
  it("includes detached, prunable and bare entries", () => {
    expect(
      parseWorktreeInventory(
        "worktree /bare\0bare\0\0worktree /missing\0HEAD abc\0detached\0prunable missing directory\0\0",
      ),
    ).toMatchObject([{ bare: true }, { branch: null, prunable: "missing directory" }]);
  });
  it("rejects partial output instead of hiding linked checkouts", () => {
    expect(() => parseWorktreeInventory("worktree /repo\0HEAD abc\0")).toThrow("Incomplete");
  });
});
