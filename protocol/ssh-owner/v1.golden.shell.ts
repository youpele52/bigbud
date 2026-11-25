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
  };
}
