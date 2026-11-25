import type { Message } from "./v1.golden.codec.ts";

export function relayOpenCase(request: (tag: number, body: Message) => Message) {
  return request(37, [
    [1, "/fixture/bin/node"],
    [2, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    [3, "/fixture/relay.mjs"],
    [4, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    [5, "cccccccccccccccccccccccccccccccc"],
  ]);
}

export function providerCases(
  request: (tag: number, body: Message) => Message,
  reply: (tag: number, body: Message) => Message,
) {
  const scope: Message = [
    [1, "thread-codex"],
    [2, 7],
    [3, "/fixture/work"],
    [4, "/fixture/bin/codex"],
  ];
  const pi: Message = [
    [1, "thread-pi"],
    [2, 9],
    [3, "/fixture/work"],
    [4, "/fixture/bin/pi"],
  ];
  const opencodeLease = new Uint8Array(32).fill(92);
  return {
    proof_unlock_synthetic_posix_password: request(53, []),
    proof_synthetic_posix_password_unlocked: reply(34, []),
    proof_opencode_open: request(50, [
      [
        1,
        [
          [1, "thread-opencode"],
          [2, 7],
          [3, "/fixture/work"],
          [4, "/fixture/bin/opencode"],
        ],
      ],
      [2, opencodeLease],
    ]),
    proof_opencode_service_open: request(50, [
      [2, opencodeLease],
      [
        3,
        [
          [1, "thread-opencode"],
          [2, 7],
          [3, "/fixture/work"],
        ],
      ],
    ]),
    proof_opencode_status: request(51, [[1, opencodeLease]]),
    proof_opencode_close: request(52, [[1, opencodeLease]]),
    proof_opencode_ready: reply(33, [
      [1, opencodeLease],
      [2, 2],
      [3, 49152],
    ]),
    proof_opencode_closed: reply(33, [
      [1, opencodeLease],
      [2, 4],
    ]),
    proof_workspace_mode_inspect: request(47, [[1, "/fixture/root"]]),
    proof_workspace_mode_publish: request(48, [
      [1, "/fixture/root"],
      [2, new Uint8Array(32).fill(81)],
      [3, "canonical claim fixture"],
    ]),
    proof_workspace_mode_publication: reply(31, [[1, 1]]),
    proof_workspace_mode_ready: reply(30, [
      [
        1,
        [
          [1, "/fixture/root"],
          [2, `machine-v1:${"a".repeat(64)}`],
          [3, 1000],
          [4, "b".repeat(64)],
          [7, new Uint8Array(32).fill(81)],
        ],
      ],
    ]),
    proof_workspace_mode_refused: reply(30, [[2, 4]]),
    proof_peer_relay_open: request(42, [
      [1, "2e789a0b-6e7b-411b-8d34-4107f1c18902"],
      [2, "8c401406-d510-44a8-8111-123456789aaa"],
      [3, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      [4, "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      [5, "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    ]),
    proof_git_advertisement_open: request(43, [
      [1, "/tmp/bigbud-picker-linux-Fixture/receive.git"],
      [2, "refs/heads/source"],
      [3, "refs/heads/main"],
      [4, "1111111111111111111111111111111111111111"],
    ]),
    proof_deployment_stage_begin: request(44, [
      [1, "2e789a0b-6e7b-411b-8d34-4107f1c18902"],
      [2, "0.1.0-aarch64-unknown-linux-gnu-aaaaaaaaaaaaaaaa"],
      [3, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      [4, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
    ]),
    proof_git_upload_open: request(45, [[1, "/tmp/bigbud-picker-linux-Fixture/upload.git"]]),
    proof_deployment_manifest_put: request(46, [
      [1, "2e789a0b-6e7b-411b-8d34-4107f1c18902"],
      [2, "8f36ab2b3fd94e8d14eae1e5904e6b9be0d43de0dad112009a6ca8b91080f85b"],
      [3, "manifest fixture"],
    ]),
    proof_pi_probe: request(40, pi),
    proof_pi_open: request(41, pi),
    proof_pi_open_resume: request(41, [...pi, [5, "/fixture/work/.pi/session.jsonl"]]),
    proof_pi_version: reply(29, [
      [1, 0],
      [2, "pi v0.99.0\n"],
    ]),
    proof_codex_probe: request(38, scope),
    proof_codex_open: request(39, scope),
    proof_codex_version: reply(28, [
      [1, 0],
      [2, "codex-cli 0.166.0\n"],
    ]),
  };
}
