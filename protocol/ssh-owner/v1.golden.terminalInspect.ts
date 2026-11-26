import { bytes, type Message } from "./v1.golden.codec.ts";

/**
 * W2 T-term production terminal verbs: Request 120 `terminal_inspect` / Reply 71
 * and U16 Request 121 `list_terminal_shells` / Reply 72, plus the additive
 * `ProofPrepareTerminal.shell` (field 6); and the W2 T-files session-FS entry
 * verbs (Request 122–124, Reply 73–74). No command or argv is ever sent.
 */
export function terminalInspectWireCases(
  request: (tag: number, operation: Message) => Message,
  reply: (tag: number, outcome: Message) => Message,
): Record<string, Message> {
  const lease = bytes("71".repeat(32));
  return {
    terminal_inspect: request(120, [[1, lease]]),
    list_terminal_shells: request(121, []),
    proof_terminal_prepare_shell: request(28, [
      [1, "/srv/work"],
      [2, "thread"],
      [3, "pane"],
      [4, 96],
      [5, 34],
      [6, "/usr/bin/zsh"],
    ]),
    terminal_processes: reply(71, [
      [1, lease],
      [2, 4242],
      [
        3,
        [
          [1, 4242],
          [2, 4200],
          [3, 4242],
          [4, 4300],
          [5, "-zsh"],
        ],
      ],
      [
        3,
        [
          [1, 4300],
          [2, 4242],
          [3, 4300],
          [4, 4300],
          [5, "vim notes.txt"],
        ],
      ],
    ]),
    terminal_processes_truncated: reply(71, [
      [1, lease],
      [2, 4242],
      [4, true],
    ]),
    terminal_shells: reply(72, [
      [1, "/bin/bash"],
      [1, "/usr/bin/zsh"],
    ]),
    // W2 T-files session-FS entry verbs (Request 122–124, Reply 73–74).
    workspace_entry_info: request(122, [
      [1, "/srv/work"],
      [2, "src/main.rs"],
    ]),
    workspace_rename: request(123, [
      [1, "/srv/work"],
      [2, "a.txt"],
      [3, "b/a.txt"],
    ]),
    workspace_rename_replace: request(123, [
      [1, "/srv/work"],
      [2, "a.tmp"],
      [3, "a.txt"],
      [4, true],
    ]),
    workspace_append: request(124, [
      [1, "/srv/work"],
      [2, "log.txt"],
      [3, Buffer.from("line\n")],
    ]),
    workspace_entry_info_reply: reply(73, [
      [1, 2],
      [2, 42],
      [3, 1_764_000_000_000],
      [4, 1_763_000_000_000],
    ]),
    workspace_entry_change: reply(74, [[1, 1]]),
  };
}
