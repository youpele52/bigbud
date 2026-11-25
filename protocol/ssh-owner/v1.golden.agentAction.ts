import type { Message } from "./v1.golden.codec.ts";

const sequence = (first: number) => Buffer.from(Array.from({ length: 16 }, (_, i) => first + i));

/**
 * Owner-compiled agent actions. The install case carries the only artifact
 * bytes on the wire; every other verb is enum-only.
 */
export function agentActionWireCases(
  request: (tag: number, operation: Message) => Message,
  reply: (tag: number, outcome: Message) => Message,
): Record<string, Message> {
  return {
    proof_agent_action: request(70, [
      [1, 5],
      [2, sequence(0)],
    ]),
    proof_agent_action_reattach: request(70, [
      [1, 5],
      [2, sequence(0)],
      [8, true],
    ]),
    proof_agent_action_install: request(70, [
      [1, 2],
      [2, sequence(16)],
      [3, "0.3.3"],
      [4, "b".repeat(64)],
      [5, 8],
      [6, "aarch64-unknown-linux-gnu"],
      [7, Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77])],
    ]),
    proof_agent_action_reply: reply(44, [
      [1, 5],
      [2, sequence(0)],
      [3, 0],
      [4, Buffer.from("absent")],
    ]),
    proof_agent_action_unknown_reply: reply(44, [
      [1, 2],
      [2, sequence(16)],
      [5, Buffer.from("partial")],
      [6, true],
      [7, true],
      [8, true],
    ]),
  };
}
