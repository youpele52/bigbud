import type { Message } from "./v1.golden.codec.ts";

/**
 * U15 production Git receive lease (Request 110–112, Reply 66). The owner
 * forwards only `<expected_old_oid> <source_oid> <destination_ref>`; stale,
 * refused and rejected outcomes are settled receipts, not error codes.
 */
export function gitReceiveWireCases(
  request: (tag: number, body: Message) => Message,
  reply: (tag: number, body: Message) => Message,
) {
  const lease = new Uint8Array(32).fill(94);
  return {
    git_receive_open: request(110, [
      [1, lease],
      [2, "/srv/work"],
      [3, "/srv/work/repo.git"],
      [4, "refs/heads/main"],
      [5, "a".repeat(40)],
      [6, "b".repeat(40)],
    ]),
    git_receive_status: request(111, [[1, lease]]),
    git_receive_close: request(112, [[1, lease]]),
    git_receive_listening: reply(66, [
      [1, lease],
      [2, 1],
      [3, "/tmp/bigbud-oc1-0123456789abcdef/s"],
    ]),
    git_receive_accepted: reply(66, [
      [1, lease],
      [2, 3],
      [4, 1],
    ]),
    git_receive_stale: reply(66, [
      [1, lease],
      [2, 3],
      [4, 4],
    ]),
  };
}
