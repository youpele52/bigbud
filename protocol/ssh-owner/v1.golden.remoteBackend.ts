import type { Message } from "./v1.golden.codec.ts";

const digest = (char: string) => char.repeat(64);

/**
 * W2 T-backend production leases (Request 100–105, Reply 61–62). A deployment step names
 * a kind and data operands only; the owner compiles the recipe. Bytes travel on the
 * owner-created lease socket, never in a frame.
 */
export function remoteBackendWireCases(
  request: (tag: number, body: Message) => Message,
  reply: (tag: number, body: Message) => Message,
) {
  const lease = new Uint8Array(32).fill(61);
  const relay = new Uint8Array(32).fill(62);
  const requestId = "0123abcd-0123-4abc-8def-0123456789ab";
  return {
    deployment_step_open: request(100, [
      [1, lease],
      [2, 7],
      [3, requestId],
      [4, "/home/bbdev"],
      [5, "1.2.3-aarch64-unknown-linux-gnu-aaaaaaaaaaaaaaaa"],
      [6, digest("a")],
      [7, digest("b")],
      [
        14,
        [
          [1, "node/bin/node"],
          [2, digest("c")],
        ],
      ],
      [
        14,
        [
          [1, "server/dist/bin.mjs"],
          [2, digest("d")],
        ],
      ],
      [
        14,
        [
          [1, "server/dist/remote-client-relay/r.mjs"],
          [2, digest("e")],
        ],
      ],
    ]),
    deployment_step_start: request(100, [
      [1, lease],
      [2, 9],
      [4, "/home/bbdev"],
      [5, "1.2.3-aarch64-unknown-linux-gnu-aaaaaaaaaaaaaaaa"],
      [12, "node/bin/node"],
      [13, "server/dist/bin.mjs"],
      [15, "0123456789abcdef0123456789abcdef"],
      [16, 1],
    ]),
    deployment_step_status: request(101, [[1, lease]]),
    deployment_step_cancel: request(102, [[1, lease]]),
    client_relay_lease_open: request(103, [
      [1, relay],
      [2, "/home/bbdev/.bigbud/backend-graphs/x/graph/node/bin/node"],
      [3, digest("c")],
      [4, "/home/bbdev/.bigbud/backend-graphs/x/graph/server/dist/r.mjs"],
      [5, digest("e")],
      [6, "0123456789abcdef0123456789abcdef"],
    ]),
    client_relay_lease_status: request(104, [[1, relay]]),
    client_relay_lease_close: request(105, [[1, relay]]),
    deployment_step_listening: reply(61, [
      [1, lease],
      [2, 1],
      [3, 3],
      [4, requestId],
      [5, "/tmp/bigbud-oc1-0123456789abcdef/s"],
    ]),
    deployment_step_exited: reply(61, [
      [1, lease],
      [2, 3],
      [3, 1],
      [4, requestId],
      [6, 0],
      [7, "home=/home/bbdev\narch=aarch64\n"],
    ]),
    deployment_step_unknown: reply(61, [
      [1, lease],
      [2, 5],
      [3, 8],
      [4, requestId],
    ]),
    client_relay_lease_listening: reply(62, [
      [1, relay],
      [2, 1],
      [3, "/tmp/bigbud-oc1-fedcba9876543210/s"],
    ]),
    client_relay_lease_exited: reply(62, [
      [1, relay],
      [2, 3],
      [4, 0],
    ]),
  };
}
