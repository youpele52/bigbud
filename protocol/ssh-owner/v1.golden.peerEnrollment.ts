/**
 * Peer enrollment wire goldens (T-peer / U9). The coordinator key reply carries
 * public metadata only; the host-key reply carries the presented key metadata
 * only. Both are distinct operations, so neither can be satisfied by ordinary
 * host trust (`inspect_trust`) or by the paired relay (`proof_peer_relay_open`).
 */
export type Message = ReadonlyArray<
  readonly [number, number | boolean | string | Uint8Array | Message]
>;

const COORDINATOR_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export function peerEnrollmentWireCases(
  request: (tag: number, operation: Message) => Message,
  reply: (tag: number, outcome: Message) => Message,
): Record<string, Message> {
  const hostKey = {
    publicKey: `ssh-ed25519 ${COORDINATOR_KEY}`,
    fingerprint: `sha256:${"1".repeat(64)}`,
    algorithm: "ssh-ed25519",
  };
  return {
    proof_ensure_peer_coordinator_key: request(71, []),
    proof_inspect_peer_host_key: request(72, [
      [1, "w1.example.test"],
      [2, 22],
    ]),
    // Same verb, different exact endpoint: the grant digest must change.
    proof_inspect_peer_host_key_other_port: request(72, [
      [1, "w1.example.test"],
      [2, 2222],
    ]),
    proof_peer_coordinator_key: reply(45, [
      [1, hostKey.publicKey],
      [2, hostKey.fingerprint],
      [3, hostKey.algorithm],
      [4, new Uint8Array([0x00, 0x61, 0xff])],
    ]),
    proof_peer_host_key: reply(46, [
      [1, "ssh-ed25519"],
      [2, "SHA256:kmYcvdi2GkPeWxB6XLjrZB8JHsy2Hm8luHMFp9GMvqk"],
      [3, `ssh-ed25519 ${COORDINATOR_KEY}`],
    ]),
  };
}
