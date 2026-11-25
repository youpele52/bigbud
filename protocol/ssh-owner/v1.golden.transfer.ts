import { bytes, type Message } from "./v1.golden.codec.ts";

/** C15 / W2 T-xfer reserved verbs and outcomes. Fixture-only in S1-S4. */
export function transferWireCases(
  request: (tag: number, operation: Message) => Message,
  reply: (tag: number, outcome: Message) => Message,
): Record<string, Message> {
  const scope = (authMode: number): Message => [
    [1, bytes("11".repeat(32))],
    [2, "fixture-target"],
    [3, bytes("04")],
    [4, authMode],
  ];
  return {
    proof_transfer_stream: request(74, [
      [1, scope(2)],
      [
        2,
        [
          [1, "fixture/source"],
          [2, "fixture/destination"],
          [3, 4096],
          [4, 8],
        ],
      ],
    ]),
    proof_packaged_rsync: request(75, [
      [1, scope(1)],
      [
        2,
        [
          [1, "fixture/tree-a"],
          [2, "fixture/tree-b"],
          [3, 8192],
          [4, 4],
        ],
      ],
    ]),
    proof_transfer_stream_state_reply: reply(47, [
      [1, bytes("22".repeat(32))],
      [2, 7],
      [3, 4096],
      [4, 48],
      [5, 48],
      [6, true],
      [7, true],
      [9, true],
      [10, 0],
    ]),
    proof_transfer_child_state_reply: reply(48, [
      [1, bytes("33".repeat(32))],
      [2, true],
      [3, 3],
      [6, 2],
    ]),
  };
}
