import type { Message } from "./v1.golden.codec.ts";

type Frame = (tag: number, body: Message) => Message;

/**
 * C06 (B) production `workspace_git` read actions (diff panel and branch list). Same Request
 * 25 as the fixture recipes; only the action enum values 13-19 are new.
 */
export function workspaceGitProductionCases(request: Frame): Record<string, Message> {
  const root = "/home/fixture/project";
  return {
    workspace_git_diff_unstaged_path: request(25, [
      [1, root],
      [2, 17],
      [3, "src/a.ts"],
    ]),
    workspace_git_untracked_file_diff: request(25, [
      [1, root],
      [2, 18],
      [3, "new.txt"],
    ]),
    workspace_git_local_branches: request(25, [
      [1, root],
      [2, 19],
    ]),
    // History panel: a commit page and one file's capped patch (fields 4-7).
    workspace_git_commit_log: request(25, [
      [1, root],
      [2, 20],
      [5, 21],
      [6, 20],
    ]),
    // Template action 47 (commit with body): typed slot values in field 8.
    workspace_git_commit_with_body: request(25, [
      [1, root],
      [2, 47],
      [8, "feat: subject"],
      [8, "body"],
    ]),
    // Template action 73 (remote add): remote name and URL slots.
    workspace_git_remote_add: request(25, [
      [1, root],
      [2, 73],
      [8, "upstream"],
      [8, "git@example.invalid:o/r.git"],
    ]),
    workspace_git_commit_file_diff: request(25, [
      [1, root],
      [2, 25],
      [3, "src/a.ts"],
      [4, "0123456789abcdef0123456789abcdef01234567"],
      [7, 262144],
    ]),
  };
}
