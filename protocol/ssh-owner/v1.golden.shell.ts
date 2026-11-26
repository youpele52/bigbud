import type { Message } from "./v1.golden.codec.ts";

/** Exec-class owner verbs. Each carries a distinct grant-bound operation. */
export function shellWireCases(
  request: (tag: number, operation: Message) => Message,
  reply: (tag: number, outcome: Message) => Message,
): Record<string, Message> {
  return {
    proof_run_thread_shell: request(67, [
      [1, "/fixture/root"],
      [2, "/fixture/root/sub"],
      [3, "thread-1"],
      [4, "printf 'thread\\n'"],
      [5, 30_000],
    ]),
    proof_run_provider_workspace_shell: request(68, [
      [1, "/fixture/root"],
      [2, "/fixture/root"],
      [3, "cursor"],
      [4, "session-1"],
      [5, "invocation-1"],
      [6, "printf 'provider\\n'"],
      [7, 30_000],
    ]),
    proof_run_acp_command: request(69, [
      [1, "/fixture/root"],
      [2, "/fixture/root"],
    ]),
    proof_thread_shell_reply: reply(41, [
      [1, Buffer.from("thread\n")],
      [2, 7],
      [3, true],
      [4, true],
    ]),
    proof_provider_shell_reply: reply(42, [
      [1, Buffer.from("provider\n")],
      [2, 9],
      [3, true],
    ]),
    proof_acp_command_reply: reply(43, [
      [1, Buffer.from("/fixture/root\n")],
      [2, 5],
      [3, true],
    ]),
    ...productionShellWireCases(request, reply),
  };
}

/**
 * W2 T-shell production exec leases (Request 90–94, Reply 56). Each open is a
 * distinct grant-bound role; status and close name the role and a lease of one
 * role never answers another. Output is read back in chunks from an offset.
 */
function productionShellWireCases(
  request: (tag: number, operation: Message) => Message,
  reply: (tag: number, outcome: Message) => Message,
): Record<string, Message> {
  const thread = new Uint8Array(32).fill(90);
  const provider = new Uint8Array(32).fill(91);
  const acp = new Uint8Array(32).fill(92);
  return {
    run_thread_shell: request(90, [
      [1, thread],
      [2, "/srv/work"],
      [3, "/srv/work/sub"],
      [4, "thread-1"],
      [5, "printf 'thread\\n'"],
      [6, 30_000],
    ]),
    run_provider_workspace_shell: request(91, [
      [1, provider],
      [2, "/srv/work"],
      [3, "/srv/work"],
      [4, "cursor"],
      [5, "session-1"],
      [6, "invocation-1"],
      [7, "printf 'provider\\n'"],
      [8, 30_000],
    ]),
    run_acp_command: request(92, [
      [1, acp],
      [2, "/srv/work"],
      [3, "/srv/work"],
    ]),
    run_acp_shell: request(95, [
      [1, new Uint8Array(32).fill(95)],
      [2, "/srv/work"],
      [3, "/srv/work/sub"],
      [4, "acp-session-1"],
      [5, "tool-call-1"],
      [6, "ls -la"],
      [7, 30_000],
    ]),
    shell_status: request(93, [
      [1, thread],
      [2, 1],
      [3, 1_048_576],
    ]),
    shell_close: request(94, [
      [1, acp],
      [2, 3],
    ]),
    shell_running: reply(56, [
      [1, provider],
      [2, 2],
      [3, 1],
    ]),
    shell_exited: reply(56, [
      [1, thread],
      [2, 1],
      [3, 2],
      [4, Buffer.from("thread\n")],
      [5, 7],
      [6, 0],
      [7, true],
    ]),
    shell_closed: reply(56, [
      [1, acp],
      [2, 3],
      [3, 3],
    ]),
  };
}
