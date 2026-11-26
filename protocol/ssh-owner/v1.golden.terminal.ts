import { bytes, type Message } from "./v1.golden.codec.ts";
import { terminalInspectWireCases } from "./v1.golden.terminalInspect.ts";

/** Fixture terminal lease frames, including the replay and cwd proof. */
export function terminalWireCases(
  request: (tag: number, operation: Message) => Message,
  reply: (tag: number, outcome: Message) => Message,
): Record<string, Message> {
  return {
    proof_terminal_open: request(15, []),
    proof_terminal_status: request(16, [[1, bytes("aabb")]]),
    proof_terminal_close: request(17, [[1, bytes("aabb")]]),
    proof_terminal_prepare: request(28, [
      [1, "/fixture/work"],
      [2, "thread"],
      [3, "pane"],
      [4, 96],
      [5, 34],
    ]),
    proof_terminal_open_reserved: request(15, [[1, bytes("aabb")]]),
    proof_terminal_cancel_reservation: request(32, [[1, bytes("aabb")]]),
    proof_terminal_input: request(26, [
      [1, bytes("aabb")],
      [2, 1],
      [3, Buffer.from("abc\n")],
    ]),
    proof_terminal_resize: request(27, [
      [1, bytes("aabb")],
      [2, 96],
      [3, 34],
    ]),
    proof_terminal_replay_request: request(33, [
      [1, bytes("aabb")],
      [2, 2],
    ]),
    proof_terminal_replay_reply: reply(25, [
      [1, bytes("aabb")],
      [2, 2],
      [3, 4],
      [
        4,
        [
          [1, 3],
          [2, Buffer.from("abcd")],
        ],
      ],
    ]),
    proof_terminal_replay_gap: reply(25, [
      [1, bytes("aabb")],
      [2, 5],
      [3, 7],
      [5, true],
    ]),
    proof_terminal_cwd_request: request(34, [[1, "/fixture/root/project dir"]]),
    proof_terminal_cwd_reply: reply(26, [[1, "/fixture/root/project dir"]]),
    proof_terminal_reserved: reply(23, [[1, bytes("aabb")]]),
    proof_terminal_reply: reply(14, [
      [1, bytes("aabb")],
      [2, 271],
      [3, true],
      [4, Buffer.from("proof")],
    ]),
    ...terminalInspectWireCases(request, reply),
  };
}
