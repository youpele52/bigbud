import type { Message } from "./v1.golden.codec.ts";

/**
 * W2 T-prov production Pi/Codex provider leases (Request 80–83, Reply 51–52). The scope
 * names a provider kind and the session only; the owner discovers the executable and
 * compiles the argv. Socket paths are owner-made.
 */
export function providerLeaseWireCases(
  request: (tag: number, body: Message) => Message,
  reply: (tag: number, body: Message) => Message,
) {
  const lease = new Uint8Array(32).fill(81);
  const pi: Message = [
    [1, 1],
    [2, "thread-pi"],
    [3, 9],
    [4, "/srv/work"],
  ];
  const codex: Message = [
    [1, 2],
    [2, "thread-codex"],
    [3, 7],
    [4, "/srv/work"],
    [5, 1],
  ];
  return {
    probe_provider: request(80, [[1, pi]]),
    // U20: a Pi resume file and a Codex home, each re-checked on the target.
    probe_provider_resume: request(80, [[1, [...pi, [6, "/home/u/.pi/agent/sessions/w/s.jsonl"]]]]),
    probe_provider_codex_home: request(80, [
      [
        1,
        [
          [1, 2],
          [2, "thread-codex"],
          [3, 7],
          [4, "/srv/work"],
          [7, "/home/u/.codex"],
        ],
      ],
    ]),
    provider_lease_open: request(81, [
      [1, lease],
      [2, codex],
    ]),
    provider_lease_status: request(82, [[1, lease]]),
    provider_lease_close: request(83, [[1, lease]]),
    provider_version: reply(51, [[2, "0.70.2\n"]]),
    provider_lease_listening: reply(52, [
      [1, lease],
      [2, 1],
      [3, "/tmp/bigbud-oc1-0123456789abcdef/s"],
      [4, "/tmp/bigbud-oc1-fedcba9876543210/s"],
    ]),
    provider_lease_exited: reply(52, [
      [1, lease],
      [2, 3],
      [5, 0],
    ]),
  };
}
