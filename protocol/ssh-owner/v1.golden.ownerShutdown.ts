import type { Message } from "./v1.golden.codec.ts";

const run = (first: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => first + i));

/**
 * Drain-time owner shutdown and attach artifact identity (Request 194, Reply 108,
 * ErrorCode 82, ProofAttachProbe field 2, ProofAttachChallenge field 3;
 * v1.owner_shutdown.proto). The shutdown verb has no operands.
 */
export function ownerShutdownWireCases(
  request: (tag: number, operation: Message) => Message,
  reply: (tag: number, outcome: Message) => Message,
): Record<string, Message> {
  return {
    owner_shutdown: request(194, []),
    owner_shutdown_report: reply(108, [
      [1, 2],
      [2, 5],
      [3, true],
    ]),
    error_owner_artifact_mismatch: reply(10, [[1, 82]]),
    attach_probe_identity: [
      [
        11,
        [
          [1, run(32)],
          [2, run(128)],
        ],
      ],
    ],
    attach_challenge_identity: [
      [
        12,
        [
          [1, run(64)],
          [2, run(96)],
          [3, run(160)],
        ],
      ],
    ],
  };
}
