import { bytes, type Message } from "./v1.golden.codec.ts";
import { workspaceGitCases } from "./v1.golden.git.ts";
import { providerCases, relayOpenCase } from "./v1.golden.relay.ts";
import { controlCases } from "./v1.golden.control.ts";
import { errorCases } from "./v1.golden.errors.ts";
import { shellWireCases } from "./v1.golden.shell.ts";
import { agentActionWireCases } from "./v1.golden.agentAction.ts";
import { terminalWireCases } from "./v1.golden.terminal.ts";
import { transferWireCases } from "./v1.golden.transfer.ts";

export const UNKNOWN_SENTINEL = 127;
const correlation: Message = [
  [1, bytes("0180ff")],
  [2, bytes("002a")],
  [3, bytes("04")],
];
export const request = (tag: number, operation: Message): Message => [
  [3, [...correlation, [4, "fixture-target"], [5, bytes("8000")], [tag, operation]]],
];
export const reply = (tag: number, outcome: Message): Message => [
  [4, [...correlation, [tag, outcome]]],
];
const list = (path?: string): Message => (path === undefined ? [] : [[1, path]]);
export const challenge = (value = "00feff"): Message => [[1, bytes(value)]];
export const pickerPath = "~/café/資料";
const sequence = (first: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => first + i));
const attachHello: Message = [
  [1, 1],
  [3, Buffer.from("fixture-profile")],
];
export const wireCases: Record<string, Message> = {
  ...controlCases,
  ...errorCases,
  ...shellWireCases(request, reply),
  ...agentActionWireCases(request, reply),
  ...terminalWireCases(request, reply),
  ...transferWireCases(request, reply),
  hello: [
    [
      1,
      [
        [1, 1],
        [3, bytes("0061ff")],
      ],
    ],
  ],
  incompatible_major: [
    [
      1,
      [
        [1, 2],
        [3, bytes("0061ff")],
      ],
    ],
  ],
  hello_accepted: [
    [
      2,
      [
        [1, 1],
        [3, bytes("002a")],
        [6, bytes("0061ff")],
      ],
    ],
  ],
  hello_attach_bootstrap: [[1, [...attachHello, [4, sequence(0)]]]],
  attach_probe: [[11, [[1, sequence(32)]]]],
  attach_challenge: [
    [
      12,
      [
        [1, sequence(64)],
        [2, bytes("0ccd3aa87d437c4c874767ca418fce1de0fd71da0a5ae5c4211db699061e584d")],
      ],
    ],
  ],
  attach_hello: [
    [
      13,
      [
        [1, attachHello],
        [2, bytes("4d37008410d3ce6598d07a89f42a18172795ab30d2ab8ae7d46cd86a2e2563f4")],
      ],
    ],
  ],
  inspect_trust: request(10, []),
  approve_trust: request(11, challenge()),
  connect: request(12, []),
  disconnect: request(13, []),
  list_home_omitted: request(14, list()),
  list_home_empty: request(14, list("")),
  list_path: request(14, list(pickerPath)),
  list_changed_same_id: request(14, list(`${pickerPath}/other`)),
  proof_client_relay_open: relayOpenCase(request),
  ...providerCases(request, reply),
  proof_agent_proxy_open: request(29, [
    [1, "/fixture/agent"],
    [2, "a".repeat(64)],
  ]),
  proof_agent_proxy_status: request(30, [[1, bytes("aabb")]]),
  proof_agent_proxy_close: request(31, [
    [1, bytes("aabb")],
    [2, true],
    [3, 2000],
  ]),
  proof_agent_proxy_exit: reply(24, [
    [1, bytes("aabb")],
    [2, 271],
    [3, true],
    [4, 0],
  ]),
  trust_required: reply(11, [
    [1, 2],
    [2, bytes("00feff")],
    [3, "ssh-ed25519"],
    [4, "SHA256:fixture"],
  ]),
  trust_verified: reply(11, [[1, 1]]),
  connected: reply(12, [[1, 1]]),
  disconnected: reply(12, [[1, 2]]),
  folders: reply(13, [
    [1, "/home/fixture/café"],
    [
      2,
      [
        [1, "src"],
        [2, 1],
      ],
    ],
    [2, [[1, "資".repeat(44)]]],
    [3, "/home/fixture"],
    [4, true],
  ]),
  folders_empty: reply(13, [
    [1, "/home/fixture"],
    [3, "/home/fixture"],
    [4, false],
  ]),
  folders_missing_metadata: reply(13, [[1, "/home/fixture"]]),
  proof_workspace_preview: request(18, [
    [1, "/fixture/root"],
    [2, "data.bin"],
    [3, []],
  ]),
  proof_workspace_range: request(18, [
    [1, "/fixture/root"],
    [2, "data.bin"],
    [
      4,
      [
        [1, 31],
        [2, 2],
      ],
    ],
  ]),
  proof_workspace_result: reply(15, [
    [1, bytes("00ff")],
    [2, 34],
    [3, true],
  ]),
  proof_snapshot_request: request(20, [
    [1, "/fixture/root"],
    [2, "watched"],
  ]),
  proof_index_request: request(21, [[1, "/fixture/root"]]),
  proof_write_request: request(22, [
    [1, "/fixture/root"],
    [2, "dir/a.txt"],
    [3, bytes("610062")],
  ]),
  proof_snapshot_reply: reply(17, [[1, "a".repeat(64)]]),
  proof_index_reply: reply(18, [
    [
      1,
      [
        [1, "dir"],
        [2, true],
      ],
    ],
    [1, [[1, "dir/a.txt"]]],
    [2, true],
  ]),
  proof_write_reply: reply(19, []),
  proof_search_request: request(23, [
    [1, "/fixture/root"],
    [2, "abc.("],
    [3, 5],
  ]),
  proof_health_request: request(24, []),
  proof_search_reply: reply(20, [
    [
      1,
      [
        [1, "dir/a.txt"],
        [2, 2],
        [3, 1],
        [4, "abc.( sample"],
      ],
    ],
    [2, true],
  ]),
  proof_health_success: reply(21, [[1, true]]),
  proof_health_unreachable: reply(21, []),
  ...workspaceGitCases(request, reply),
  proof_deployment_request: request(35, [[1, "2e789a0b-6e7b-411b-8d34-4107f1c18902"]]),
  proof_deployment_completion_request: request(36, [
    [1, "2e789a0b-6e7b-411b-8d34-4107f1c18902"],
    [2, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ]),
  proof_deployment_reply: reply(27, [
    [1, 70],
    [3, "synthetic failure\n"],
  ]),
  proof_deployment_action: request(73, [
    [1, "2e789a0b-6e7b-411b-8d34-4107f1c18902"],
    [2, 4],
    [3, "1.2.3-aarch64-unknown-linux-gnu-0011223344556677"],
    [4, "a".repeat(64)],
    [5, "b".repeat(64)],
    [11, "bin/node"],
    [12, "app/entry.mjs"],
    [
      13,
      [
        [1, "bin/node"],
        [2, "d".repeat(64)],
      ],
    ],
  ]),
  proof_deployment_action_result: reply(27, [
    [1, 0],
    [2, "published\n"],
    [4, 2],
  ]),
  proof_directory_root: request(19, [[1, "/fixture/root"]]),
  proof_directory_nested: request(19, [
    [1, "/fixture/root"],
    [2, "folder with space"],
  ]),
  proof_directory_result: reply(16, [
    [
      1,
      [
        [1, "hidden"],
        [2, true],
      ],
    ],
    [1, [[1, "name\twith-tab"]]],
    [2, true],
  ]),
  // Empty operands keep these vectors purely syntactic; semantic admission is owner-tested.
  proof_workspace_guarded_write_begin: request(55, []),
  proof_workspace_guarded_write_chunk: request(56, []),
  proof_workspace_guarded_write_commit: request(57, []),
  proof_workspace_guarded_write_abort: request(58, []),
  proof_workspace_guarded_write_apply: request(59, []),
  proof_workspace_create: request(60, []),
  proof_workspace_create_directory: request(61, [
    [1, "/fixture/root"],
    [2, "new folder"],
  ]),
  proof_workspace_delete_entry: request(62, [
    [1, "/fixture/root"],
    [2, "old.txt"],
    [3, 1],
  ]),
  proof_workspace_write_begin: request(63, [
    [
      1,
      [
        [1, "op-1"],
        [2, "/fixture/root"],
        [3, "a.txt"],
        [4, 3],
      ],
    ],
  ]),
  proof_workspace_write_chunk: request(64, [
    [
      1,
      [
        [1, "op-1"],
        [2, "/fixture/root"],
        [3, "a.txt"],
        [4, 3],
      ],
    ],
    [2, Buffer.from(Array.from({ length: 40 }, (_, index) => index))],
    [4, bytes("616263")],
  ]),
  proof_workspace_write_commit: request(65, [
    [
      1,
      [
        [1, "op-1"],
        [2, "/fixture/root"],
        [3, "a.txt"],
        [4, 3],
      ],
    ],
    [2, Buffer.from(Array.from({ length: 40 }, (_, index) => index))],
  ]),
  proof_workspace_write_abort: request(66, [
    [
      1,
      [
        [1, "op-1"],
        [2, "/fixture/root"],
        [3, "a.txt"],
        [4, 3],
      ],
    ],
    [2, Buffer.from(Array.from({ length: 40 }, (_, index) => index))],
  ]),
  proof_workspace_readiness: request(54, []),
  proof_workspace_readiness_result: reply(35, []),
  proof_workspace_guarded_write_stage: reply(36, []),
  proof_workspace_guarded_write_result: reply(37, []),
  proof_workspace_create_result: reply(38, []),
  proof_workspace_entry_mutation: reply(39, [[1, []]]),
  proof_workspace_write_stage: reply(40, [
    [1, Buffer.from(Array.from({ length: 40 }, (_, index) => index))],
  ]),
};
