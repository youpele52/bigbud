import type { Message } from "./v1.golden.codec.ts";

/**
 * W7 remote system stats: Request 180 `sample_system_status` (no operands) and
 * Reply 101 `system_status_sample` (the owner recipe's sectioned text). No
 * command, argv, path or environment is ever sent.
 */
export function systemStatusWireCases(
  request: (tag: number, operation: Message) => Message,
  reply: (tag: number, outcome: Message) => Message,
): Record<string, Message> {
  return {
    sample_system_status: request(180, []),
    system_status_sample: reply(101, [
      [1, "###OS###\nLinux\n###CPU###\ncpu  1 0 1 8 0 0 0 0 0 0\n###END###\n"],
    ]),
  };
}
