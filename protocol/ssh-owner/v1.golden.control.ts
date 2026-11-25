import type { Message } from "./v1.golden.codec.ts";

const id = Buffer.from("id");
const target = "ssh:fixture";
const PEER_PUBLIC_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const peerCorrelation: Message = [
  [1, Buffer.from("0180ff", "hex")],
  [2, Buffer.from("002a", "hex")],
  [3, Buffer.from("04", "hex")],
];
const peerRequest = (tag: number, operation: Message): Message => [
  [
    3,
    [...peerCorrelation, [4, "fixture-target"], [5, Buffer.from("8000", "hex")], [tag, operation]],
  ],
];
const peerReply = (tag: number, outcome: Message): Message => [
  [4, [...peerCorrelation, [tag, outcome]]],
];

export const controlCases = {
  proof_grant_request: [
    [
      5,
      [
        [1, id],
        [2, Buffer.from("owner")],
        [3, Buffer.from("gen")],
        [4, target],
        [14, []],
      ],
    ],
  ],
  proof_grant_reply: [
    [
      6,
      [
        [1, id],
        [2, Buffer.from("grant")],
      ],
    ],
  ],
  proof_storage_hydrate: [[7, [[1, target]]]],
  proof_storage_snapshot: [
    [
      8,
      [
        [1, target],
        [2, "epoch"],
        [3, 7],
        [4, true],
      ],
    ],
  ],
  proof_storage_transition: [
    [
      9,
      [
        [1, id],
        [2, target],
        [3, "epoch"],
        [4, 7],
        [5, true],
      ],
    ],
  ],
  proof_storage_result: [
    [
      10,
      [
        [1, id],
        [2, 8],
        [3, true],
      ],
    ],
  ],
  proof_storage_result_refused: [
    [
      10,
      [
        [1, id],
        [4, 13],
      ],
    ],
  ],
  // Peer enrollment (T-peer / U9): public metadata only. Same request envelope
  // shape as the golden codec's `request`/`reply` helpers.
  proof_ensure_peer_coordinator_key: peerRequest(71, []),
  proof_inspect_peer_host_key: peerRequest(72, [
    [1, "w1.example.test"],
    [2, 22],
  ]),
  proof_inspect_peer_host_key_other_port: peerRequest(72, [
    [1, "w1.example.test"],
    [2, 2222],
  ]),
  proof_peer_coordinator_key: peerReply(45, [
    [1, `ssh-ed25519 ${PEER_PUBLIC_KEY}`],
    [2, `sha256:${"1".repeat(64)}`],
    [3, "ssh-ed25519"],
    [4, Buffer.from("0061ff", "hex")],
  ]),
  proof_peer_host_key: peerReply(46, [
    [1, "ssh-ed25519"],
    [2, "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk"],
    [3, `ssh-ed25519 ${PEER_PUBLIC_KEY}`],
  ]),
  // Read-only alias discovery (field 76) and metadata only outcome (field 49).
  list_aliases: peerRequest(76, []),
  proof_aliases: peerReply(49, [
    [
      1,
      [
        [1, "build-box"],
        [2, "build.internal"],
        [3, 2222],
        [4, "ci"],
        [5, "build-trust"],
        [6, 1],
        [8, "user_config"],
        [9, 5],
      ],
    ],
    [
      1,
      [
        [1, "blocked"],
        [2, "blocked.internal"],
        [3, 22],
        [6, 3],
        [7, 1],
        [8, "user_config"],
        [9, 9],
        [
          10,
          [
            [1, "localcommand"],
            [2, "Remove the unsupported directive from this host."],
            [3, "user_config"],
            [4, 9],
          ],
        ],
      ],
    ],
    [2, true],
    [3, 256],
  ]),
} satisfies Record<string, Message>;
