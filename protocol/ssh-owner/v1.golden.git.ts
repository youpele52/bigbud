import type { Message } from "./v1.golden.codec.ts";

type Frame = (tag: number, body: Message) => Message;

export function workspaceGitCases(request: Frame, reply: Frame): Record<string, Message> {
  const root = "/tmp/bigbud-picker-linux-Fixture/client";
  return {
    proof_git_tracked_push: request(49, [
      [
        1,
        [
          [1, root],
          [2, `${root}/.git`],
          [3, `${root}/.git`],
        ],
      ],
      [2, "origin"],
      [3, "refs/heads/main"],
      [4, "refs/heads/main"],
      [5, "1".repeat(40)],
      [
        6,
        [
          [1, "ssh://picker@127.0.0.1:22222/receive.git"],
          [2, "ssh:fixture-target"],
          [3, new Uint8Array(32).fill(82)],
          [4, "127.0.0.1"],
          [5, "picker"],
          [6, 22222],
          [7, "/receive.git"],
          [8, "2".repeat(40)],
        ],
      ],
      [7, 30000],
    ]),
    proof_git_tracked_push_reply: reply(32, [[1, 2]]),
    proof_git_status: request(25, [
      [1, "/fixture/root"],
      [2, 1],
    ]),
    proof_git_inside: request(25, [
      [1, "/fixture/root"],
      [2, 2],
    ]),
    proof_git_success: reply(22, [
      [1, 0],
      [2, "true\n"],
    ]),
    proof_git_exit: reply(22, [
      [1, 128],
      [3, "synthetic failure\n"],
    ]),
    proof_git_staged_numstat: request(25, [
      [1, "/fixture/root"],
      [2, 3],
    ]),
    proof_git_unstaged_numstat: request(25, [
      [1, "/fixture/root"],
      [2, 4],
    ]),
    proof_git_origin_default: request(25, [
      [1, "/fixture/root"],
      [2, 5],
    ]),
    proof_git_origin_url: request(25, [
      [1, "/fixture/root"],
      [2, 6],
    ]),
    proof_git_status_nul: request(25, [
      [1, root],
      [2, 7],
    ]),
    proof_git_show_toplevel: request(25, [
      [1, root],
      [2, 8],
    ]),
    proof_git_restore_paths: request(25, [
      [1, root],
      [2, 9],
      [3, "a.txt"],
      [3, "nested/b.txt"],
    ]),
    proof_git_clean_paths: request(25, [
      [1, root],
      [2, 10],
      [3, "new.txt"],
    ]),
    proof_git_stage_paths: request(25, [
      [1, root],
      [2, 11],
      [3, "a.txt"],
    ]),
    proof_git_untracked_numstat: request(25, [
      [1, root],
      [2, 12],
      [3, "new.txt"],
    ]),
    proof_git_outcome_unknown: reply(22, [[4, 3]]),
    proof_git_outcome_cancelled: reply(22, [[4, 2]]),
  };
}
